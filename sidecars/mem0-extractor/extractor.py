#!/usr/bin/env python3
"""Mem0-style extraction sidecar for memory-xx.

This service intentionally does not persist through Mem0. It borrows Mem0
prompting ideas and prompt assets, calls an OpenAI-compatible LLM endpoint,
then returns memory-xx's extraction schema.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

import requests

try:
    from mem0.configs import prompts as mem0_prompts
except Exception:  # pragma: no cover - optional runtime dependency
    mem0_prompts = None


MEMORY_TYPES = {"preference", "fact", "decision", "procedure", "constraint"}
OPERATIONS = {"add", "update", "merge", "no_change", "delete_candidate"}
STRATEGIES = {
    "simple_add",
    "multi_add",
    "update_conflict",
    "procedure",
    "agent_memory",
    "skip_guard",
}


def env(name: str, fallback: str = "") -> str:
    return os.environ.get(name, fallback).strip()


HOST = env("MEMORY_XX_MEM0_EXTRACTOR_HOST", env("MEMORY_INTELLIGENCE_MEM0_HOST", "127.0.0.1"))
PORT = int(env("MEMORY_XX_MEM0_EXTRACTOR_PORT", env("MEMORY_INTELLIGENCE_MEM0_PORT", "5220")))


def openai_chat_completions_endpoint(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    if re.search(r"/chat/completions$", trimmed, re.I):
        return trimmed
    return trimmed + "/chat/completions"


def resolve_endpoint() -> str:
    base_url = env("MEMORY_XX_MEM0_BASE_URL", env("MEMORY_INTELLIGENCE_MEM0_BASE_URL", env("MEMORY_INTELLIGENCE_BASE_URL")))
    if base_url:
        return openai_chat_completions_endpoint(base_url)
    return env("MEMORY_XX_MEM0_ENDPOINT", env("MEMORY_INTELLIGENCE_MEM0_ENDPOINT", env("MEMORY_INTELLIGENCE_ENDPOINT")))


ENDPOINT = resolve_endpoint()
MODEL = env("MEMORY_XX_MEM0_MODEL", env("MEMORY_INTELLIGENCE_MEM0_MODEL", env("MEMORY_INTELLIGENCE_MODEL", "MiniMax-M2.7-highspeed")))
API_KEY = env("MEMORY_XX_MEM0_API_KEY", env("MEMORY_INTELLIGENCE_MEM0_API_KEY", env("MEMORY_INTELLIGENCE_API_KEY")))
PROTOCOL = env("MEMORY_XX_MEM0_PROTOCOL", env("MEMORY_INTELLIGENCE_MEM0_PROTOCOL", env("MEMORY_INTELLIGENCE_PROTOCOL", "openai"))).lower()
TIMEOUT_SECONDS = max(3, int(env("MEMORY_XX_MEM0_TOTAL_BUDGET_MS", env("MEMORY_INTELLIGENCE_MEM0_TOTAL_BUDGET_MS", "16000"))) // 1000)
MAX_TOKENS = int(env("MEMORY_XX_MEM0_MAX_TOKENS", env("MEMORY_INTELLIGENCE_MEM0_MAX_TOKENS", "512")))
MAX_CONCURRENCY = max(1, int(env("MEMORY_XX_MEM0_MAX_CONCURRENCY", env("MEMORY_INTELLIGENCE_MEM0_MAX_CONCURRENCY", "4"))))
SEMAPHORE = threading.Semaphore(MAX_CONCURRENCY)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8", errors="replace")
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) else {}


def contains_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text))


def clean_canonical_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    cleaned = re.sub(r"^(?:请)?(?:记住|记一下|帮我记一下)[：:\s]+", "", cleaned).strip()
    cleaned = re.sub(r"(?:。|；|;|,|，)?\s*测试标记\s*[0-9a-zA-Z_-]+\s*$", "", cleaned).strip()
    cleaned = re.sub(r"\b(?:run_id|scope_id)\s*[:=]\s*[0-9a-zA-Z_-]+\b", "", cleaned, flags=re.I).strip()
    return cleaned


def is_skip_intent(text: str) -> bool:
    lower = text.lower()
    if contains_any(
        lower,
        [
            r"\bdo not remember\b",
            r"\bdon't remember\b",
            r"\bdo not store\b",
            r"\btemporary test\b",
            r"\bbenchmark sample\b",
            r"\bschema example\b",
            r"\brun_id\b",
            r"\bscope_id\b",
            r"\bignore this memory\b",
            r"\bplease forget this test\b",
            r"不需要记住",
            r"不要记住",
            r"无需记忆",
            r"不要保存",
            r"临时测试",
            r"只是.*测试",
            r"schema\s*示例",
            r"基准测试样本",
        ],
    ):
        return True
    explicit_memory = contains_any(lower, [r"^(?:请)?(?:记住|记一下|帮我记一下)[：:]", r"^以后", r"发布前"])
    question_like = contains_any(text, [r"[？?]\s*(?:测试标记\s*[0-9a-zA-Z_-]+)?\s*$", r"哪些问题", r"怎么做", r"为什么"])
    return question_like and not explicit_memory


def classify_strategy(text: str, existing: list[Any]) -> str:
    lower = text.lower()
    if is_skip_intent(text):
        return "skip_guard"
    if existing or contains_any(lower, [r"\bupdate\b", r"\breplace\b", r"\bno longer\b", r"\binstead\b", r"\bchanged\b"]):
        return "update_conflict"
    if contains_any(lower, [r"\bstep\b", r"\bworkflow\b", r"\bprocedure\b", r"\bfirst\b.+\bthen\b", r"\bafter that\b"]):
        return "procedure"
    if contains_any(lower, [r"\bagent\b", r"\bopenclaw\b", r"\bcodex\b", r"\bclaude\b", r"\bxiaoxiao\b"]):
        return "agent_memory"
    separators = len(re.findall(r"[;；]|(?:\balso\b)|(?:\band\b)|(?:另外)|(?:同时)", text, re.I))
    if separators >= 2:
        return "multi_add"
    return "simple_add"


def infer_type(text: str) -> str:
    lower = text.lower()
    if contains_any(lower, [r"\bprefer\b", r"\bpreference\b", r"偏好", r"喜欢"]):
        return "preference"
    if contains_any(lower, [r"\bmust\b", r"\bshould\b", r"\bnever\b", r"\blimit\b", r"必须", r"应该", r"不能", r"限制"]):
        return "constraint"
    if contains_any(lower, [r"\bprocedure\b", r"\bworkflow\b", r"\bstep\b", r"流程", r"步骤"]):
        return "procedure"
    if contains_any(lower, [r"\bdecision\b", r"\bdecided\b", r"决定", r"决策"]):
        return "decision"
    return "fact"


def slug(text: str) -> str:
    value = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", text.lower()).strip("-")
    return value[:48] or "general"


def title_for(memory_type: str, content: str) -> str:
    cleaned = re.sub(r"\s+", " ", content).strip()
    if not cleaned:
        return f"{memory_type}:general"
    return cleaned[:80]


def dedupe_key_for(memory_type: str, topic: str, canonical: str) -> str:
    normalized = re.sub(r"\s+", " ", canonical.strip().lower())
    digest = hashlib.sha256(f"{memory_type}:{topic}:{normalized}".encode("utf-8")).hexdigest()
    return digest[:32]


def get_prompt_asset(strategy: str) -> str:
    # Keep the hot-path prompt compact. The installed mem0 prompts are useful
    # as strategy references, but sending the full prompt makes reasoning
    # models spend too long before JSON.
    if strategy == "procedure":
        return "Mem0 procedural strategy: preserve reusable workflow steps and execution lessons."
    if strategy == "agent_memory":
        return "Mem0 agent strategy: store stable facts, capabilities, constraints, and lessons about agents."
    if strategy == "update_conflict":
        return "Mem0 update strategy: compare against existing memories and choose add, update, merge, or no_change."
    return "Mem0 user strategy: extract durable user facts, preferences, constraints, decisions, and procedures."


def build_messages(payload: dict[str, Any], strategy: str) -> list[dict[str, str]]:
    text = str(payload.get("text") or "")
    existing = payload.get("existing_memories")
    existing = existing if isinstance(existing, list) else []
    scope_hint = payload.get("scope_hint") if isinstance(payload.get("scope_hint"), dict) else {}
    prompt_asset = get_prompt_asset(strategy)
    system = (
        "You are a Mem0-style memory extraction strategy layer for memory-xx. "
        "Return only valid JSON. Do not include markdown or explanations. "
        "Do not output <think> or reasoning. Never persist data yourself. "
        "Produce atomic canonical memories only."
    )
    user = (
        f"Mem0 strategy: {strategy}. {prompt_asset}\n"
        "Extract durable long-term memory from TEXT.\n"
        "Skip questions, greetings, temporary tests, benchmark text, schema examples, run_id, and scope_id.\n"
        "Do not store the words 'remember this'. Store only the durable fact/preference/constraint/decision/procedure.\n"
        "If TEXT is Chinese, canonical_content must stay Chinese. Do not translate Chinese text into English.\n"
        "Split multiple facts into atomic memories. If EXISTING already covers it, use no_change or merge.\n"
        "Return JSON only in this shape: "
        '{"should_write":true,"confidence":0.9,"strategy":"'
        + strategy
        + '","operation":"add","quality_flags":[],"memories":[{"canonical_content":"...","memory_type":"preference|fact|decision|procedure|constraint","topic":"...","title":"...","confidence":0.9,"operation":"add|update|merge|no_change"}]}\n'
        f"SCOPE: {json.dumps(scope_hint, ensure_ascii=False)}\n"
        f"EXISTING: {json.dumps(existing[:5], ensure_ascii=False)}\n"
        f"TEXT: {text}"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def strip_thinking(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.I | re.S).strip()


def extract_json(text: str) -> dict[str, Any]:
    cleaned = strip_thinking(text)
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass
    start = cleaned.find("{")
    if start < 0:
        return {}
    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(cleaned[start:], start=start):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    parsed = json.loads(cleaned[start : index + 1])
                    return parsed if isinstance(parsed, dict) else {}
    return {}


def call_llm(messages: list[dict[str, str]]) -> tuple[dict[str, Any] | None, str | None, str | None]:
    if PROTOCOL != "openai":
        return None, "http_error", "Only OpenAI-compatible protocol is enabled for this sidecar"
    if not ENDPOINT or not API_KEY:
        return None, "fallback_config_missing", "Missing MiniMax endpoint or API key"

    request_body = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        response = requests.post(ENDPOINT, headers=headers, json=request_body, timeout=TIMEOUT_SECONDS)
    except requests.Timeout:
        return None, "timeout", "MiniMax request timed out"
    except requests.RequestException as exc:
        return None, "network_error", str(exc)

    if response.status_code == 429:
        return None, "llm_http_429", "MiniMax returned HTTP 429"
    if response.status_code >= 500:
        return None, "llm_http_5xx", f"MiniMax returned HTTP {response.status_code}"
    if response.status_code >= 400:
        return None, "http_error", f"MiniMax returned HTTP {response.status_code}"

    try:
        body = response.json()
        content = body["choices"][0]["message"]["content"]
    except Exception:
        return None, "parse_error", "MiniMax returned an unexpected OpenAI response shape"

    parsed = extract_json(str(content))
    if not parsed:
        return None, "parse_error", "MiniMax response did not contain JSON"
    return parsed, None, None


def normalize_memory(raw: Any, request_text: str, default_operation: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    canonical = (
        raw.get("canonical_content")
        or raw.get("content")
        or raw.get("memory")
        or raw.get("text")
        or raw.get("fact")
    )
    canonical = clean_canonical_text(str(canonical or ""))
    if not canonical:
        return None
    memory_type = str(raw.get("memory_type") or raw.get("type") or infer_type(canonical)).strip().lower()
    if memory_type not in MEMORY_TYPES:
        memory_type = infer_type(canonical)
    if memory_type == "procedure":
        step_like = contains_any(canonical, [r"\bstep\b", r"\bworkflow\b", r"\bfirst\b.+\bthen\b", r"步骤", r"流程", r"先.+再"])
        constraint_like = contains_any(request_text + "\n" + canonical, [r"\bmust\b", r"\bshould\b", r"\bnever\b", r"必须", r"应该", r"不能"])
        if constraint_like and not step_like:
            memory_type = "constraint"
    operation = str(raw.get("operation") or default_operation or "add").strip().lower()
    if operation not in OPERATIONS:
        operation = default_operation if default_operation in OPERATIONS else "add"
    confidence = raw.get("confidence")
    try:
        confidence = float(confidence)
    except Exception:
        confidence = 0.86
    confidence = max(0.0, min(0.99, confidence))
    topic = str(raw.get("topic") or slug(canonical)).strip().lower()[:80] or "general"
    title = str(raw.get("title") or title_for(memory_type, canonical)).strip()[:120]
    dedupe_key = str(raw.get("dedupe_key") or raw.get("dedupeKey") or "").strip()
    if not dedupe_key:
        dedupe_key = dedupe_key_for(memory_type, topic, canonical)
    return {
        "canonical_content": canonical,
        "content": canonical,
        "memory_type": memory_type,
        "topic": topic,
        "title": title,
        "dedupe_key": dedupe_key,
        "confidence": confidence,
        "operation": operation,
        "existing_memory_id": str(raw.get("existing_memory_id") or "").strip() or None,
        "conflict_reason": str(raw.get("conflict_reason") or "").strip() or None,
    }


def normalize_output(parsed: dict[str, Any], payload: dict[str, Any], strategy: str) -> dict[str, Any]:
    request_text = str(payload.get("text") or "")
    raw_memories = parsed.get("memories")
    if raw_memories is None and parsed.get("memory") is not None:
        raw_memories = [parsed.get("memory")]
    if raw_memories is None and parsed.get("facts") is not None:
        raw_memories = parsed.get("facts")
    if raw_memories is None:
        raw_memories = []
    if not isinstance(raw_memories, list):
        raw_memories = [raw_memories]

    operation = str(parsed.get("operation") or ("no_change" if strategy == "skip_guard" else "add")).strip().lower()
    if operation not in OPERATIONS:
        operation = "add"

    memories = [
        memory
        for memory in (normalize_memory(item, request_text, operation) for item in raw_memories)
        if memory is not None
    ]

    parsed_should_write = parsed.get("should_write")
    if isinstance(parsed_should_write, bool):
        should_write = parsed_should_write
    else:
        should_write = len(memories) > 0 and operation not in {"no_change", "delete_candidate"}

    if strategy == "skip_guard":
        should_write = False
        operation = "no_change"
        memories = []

    try:
        confidence = float(parsed.get("confidence", 0.88 if should_write else 0.96))
    except Exception:
        confidence = 0.88 if should_write else 0.96
    confidence = max(0.0, min(0.99, confidence))

    quality_flags = parsed.get("quality_flags")
    if not isinstance(quality_flags, list):
        quality_flags = []
    quality_flags = [str(flag) for flag in quality_flags if str(flag).strip()]
    if not should_write:
        quality_flags.append("skip_guard" if strategy == "skip_guard" else "no_durable_memory")
    if has_cjk(request_text) and should_write:
        for memory in memories:
            if not has_cjk(str(memory.get("canonical_content") or "")):
                quality_flags.append("canonical_translated_from_chinese")
                memory["confidence"] = min(float(memory.get("confidence") or confidence), 0.74)
                confidence = min(confidence, 0.74)
    if should_write and not memories:
        raise ValueError("empty_memory")
    for memory in memories:
        canonical = str(memory.get("canonical_content") or "")
        if contains_any(canonical.lower(), [r"\brun_id\b", r"\bscope_id\b", r"\bbenchmark sample\b", r"schema example", r"临时测试"]):
            quality_flags.append("possible_raw_or_meta_leak")
            memory["confidence"] = min(float(memory.get("confidence") or confidence), 0.69)
            confidence = min(confidence, 0.69)

    return {
        "ok": True,
        "should_write": should_write,
        "confidence": confidence,
        "strategy": strategy,
        "operation": operation,
        "quality_flags": quality_flags,
        "memories": memories,
        "schema_repair_applied": True,
    }


def compact_fast_extract(payload: dict[str, Any], strategy: str) -> dict[str, Any] | None:
    text = str(payload.get("text") or "").strip()
    existing = payload.get("existing_memories")
    if existing or not has_cjk(text):
        return None
    match = re.match(r"^(?:请)?(?:记住|记一下|帮我记一下)[：:]\s*(.+)$", text, flags=re.S)
    canonical = ""
    if match:
        canonical = clean_canonical_text(match.group(1))
    elif re.match(r"^以后(?:关于[^，,。；;]+[，,])?.+", text, flags=re.S):
        canonical = clean_canonical_text(text)
    elif contains_any(text, [r"发布前.+先.+再", r"先.+再.+失败时"]):
        canonical = clean_canonical_text(text)
    else:
        return None
    if len(canonical) < 6:
        return None
    memory_type = infer_type(canonical)
    memory = {
        "canonical_content": canonical,
        "content": canonical,
        "memory_type": memory_type,
        "topic": slug(canonical),
        "title": title_for(memory_type, canonical),
        "dedupe_key": dedupe_key_for(memory_type, slug(canonical), canonical),
        "confidence": 0.88,
        "operation": "add",
        "existing_memory_id": None,
        "conflict_reason": None,
    }
    return {
        "ok": True,
        "should_write": True,
        "confidence": 0.88,
        "strategy": f"{strategy}_compact_fast",
        "operation": "add",
        "quality_flags": ["explicit_memory_intent", "source_language_preserved"],
        "memories": [memory],
        "schema_repair_applied": False,
    }


def messages_to_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    parts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        if role in {"user", "assistant", "system", "tool"}:
            parts.append(f"{role}: {content}")
        else:
            parts.append(content)
    return "\n".join(parts).strip()


def official_payload_to_extract_payload(payload: dict[str, Any]) -> dict[str, Any]:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    scope_hint = metadata.get("scope_hint") if isinstance(metadata.get("scope_hint"), dict) else {}
    session_context = metadata.get("session_context") if isinstance(metadata.get("session_context"), dict) else {}
    existing = metadata.get("existing_memories")
    text = str(payload.get("text") or "").strip() or messages_to_text(payload.get("messages"))
    return {
        "text": text,
        "agent_id": payload.get("agent_id") or metadata.get("agent_id") or payload.get("user_id"),
        "user_id": payload.get("user_id"),
        "workspace_id": metadata.get("workspace_id"),
        "scope_hint": scope_hint,
        "existing_memories": existing if isinstance(existing, list) else [],
        "mode": metadata.get("mode") or "write",
        "strategy_version": metadata.get("strategy_version") or "v2",
        "session_context": session_context,
    }


def official_response(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": body.get("ok", True),
        "event_id": body.get("event_id"),
        "should_write": body.get("should_write", False),
        "confidence": body.get("confidence", 0.0),
        "strategy": body.get("strategy", "mem0_official_add"),
        "operation": body.get("operation", "no_change"),
        "quality_flags": body.get("quality_flags", []),
        "memories": body.get("memories", []),
        "schema_repair_applied": body.get("schema_repair_applied", False),
    }


def extract(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    text = str(payload.get("text") or "").strip()
    if not text:
        return 400, {"ok": False, "failure_reason": "schema_invalid", "error": "Missing text"}

    existing = payload.get("existing_memories")
    existing = existing if isinstance(existing, list) else []
    strategy = str(payload.get("strategy_version") or "v2").lower()
    strategy = classify_strategy(text, existing) if strategy in {"v2", "v1", ""} else strategy
    if strategy not in STRATEGIES:
        strategy = classify_strategy(text, existing)

    if strategy == "skip_guard":
        return 200, {
            "ok": True,
            "should_write": False,
            "confidence": 0.98,
            "strategy": strategy,
            "operation": "no_change",
            "quality_flags": ["skip_guard"],
            "memories": [],
            "schema_repair_applied": False,
        }

    fast = compact_fast_extract(payload, strategy)
    if fast is not None:
        return 200, fast

    if not SEMAPHORE.acquire(timeout=1):
        return 429, {"ok": False, "failure_reason": "llm_http_429", "error": "Mem0 extractor concurrency limit reached"}
    started = time.time()
    try:
        parsed, failure_reason, error = call_llm(build_messages(payload, strategy))
    finally:
        SEMAPHORE.release()

    if parsed is None:
        return 502, {
            "ok": False,
            "failure_reason": failure_reason or "mem0_error",
            "error": error or "Mem0 extractor failed",
            "transport_error": failure_reason in {"timeout", "network_error", "llm_http_429", "llm_http_5xx", "http_error"},
            "strategy": strategy,
        }

    try:
        normalized = normalize_output(parsed, payload, strategy)
    except ValueError as exc:
        return 422, {"ok": False, "failure_reason": str(exc), "error": str(exc), "strategy": strategy}
    normalized["latency_ms"] = round((time.time() - started) * 1000)
    return 200, normalized


class Handler(BaseHTTPRequestHandler):
    server_version = "memory-xx-mem0-extractor/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        print(f"{self.log_date_time_string()} {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            json_response(self, 404, {"ok": False, "error": "not_found"})
            return
        parsed = urlparse(ENDPOINT)
        json_response(
            self,
            200,
            {
                "ok": True,
                "service": "memory-xx-mem0-extractor",
                "protocol": PROTOCOL,
                "model": MODEL,
                "endpoint_configured": bool(ENDPOINT),
                "api_key_configured": bool(API_KEY),
                "endpoint_host": parsed.netloc,
                "concurrency": MAX_CONCURRENCY,
                "mem0_prompt_assets": mem0_prompts is not None,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/extract", "/memories/add", "/v1/memories/add", "/api/v1/memories/add"}:
            json_response(self, 404, {"ok": False, "error": "not_found"})
            return
        try:
            payload = read_json(self)
            official = self.path != "/extract"
            extract_payload = official_payload_to_extract_payload(payload) if official else payload
            status, body = extract(extract_payload)
            if official and status < 400:
                body = official_response(body)
            json_response(self, status, body)
        except json.JSONDecodeError:
            json_response(self, 400, {"ok": False, "failure_reason": "parse_error", "error": "Invalid JSON body"})
        except Exception as exc:  # pragma: no cover - last-resort HTTP safety
            json_response(self, 500, {"ok": False, "failure_reason": "mem0_error", "error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"memory-xx mem0 extractor listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
