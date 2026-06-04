# Mem0-Style Extractor

Python extraction sidecar that borrows Mem0 prompting strategy ideas and returns
memory-xx extraction schema. It does not persist through Mem0.

Run:

```bash
python -m venv .venv
. .venv/bin/activate
pip install requests mem0ai
MEMORY_XX_MEM0_BASE_URL=https://example.invalid/v1 \
MEMORY_XX_MEM0_API_KEY=<set-private-key> \
python sidecars/mem0-extractor/extractor.py
```

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `MEMORY_XX_MEM0_EXTRACTOR_PORT` | Local sidecar port, defaults to `5220` |
| `MEMORY_XX_MEM0_BASE_URL` | OpenAI-compatible chat completions base URL |
| `MEMORY_XX_MEM0_ENDPOINT` | Full chat completions endpoint override |
| `MEMORY_XX_MEM0_MODEL` | Extraction model |
| `MEMORY_XX_MEM0_API_KEY` | API key |
| `MEMORY_XX_MEM0_TOTAL_BUDGET_MS` | Request timeout budget |

`mem0ai` is optional at runtime. If its prompt package is absent, the sidecar
uses compact built-in prompts.
