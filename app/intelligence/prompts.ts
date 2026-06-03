const EXTRACTION_SCHEMA = "{\"should_write\":boolean,\"confidence\":number,\"memories\":[{\"canonical_content\":string,\"memory_type\":\"preference|fact|decision|procedure|constraint\",\"memory_class\":\"long_term_fact|preference|constraint|decision|procedure|operational_issue|test_evidence|audit_evidence|runtime_noise|ephemeral_task|explicit_no_memory|unknown_source_quarantine\",\"topic\":string,\"title\":string,\"confidence\":number,\"evidence_span\"?:string,\"why_long_term\"?:string,\"temporal_validity\"?:string,\"source_intent\"?:string}]}";

export const EXTRACTION_SYSTEM_PROMPT = "你是 memory-xx 的长期记忆抽取器。只返回一个紧凑、合法的 JSON 对象；不要输出 Markdown，不要解释。";

export function buildExtractionUserPrompt(text: string, scopeHint?: { scope_type: string; scope_id: string }): string {
  const scope = scopeHint ? scopeHint.scope_type + ":" + scopeHint.scope_id : "project:default";
  return [
    "只有 TEXT_START/TEXT_END 之间的正文可以被记忆。不要从规则、schema、示例或存储元数据中抽取记忆。",
    "以下只是存储元数据，绝不能作为记忆正文保存：" + scope,
    "决策规则：",
    "- 明确要求记住（例如：请记住、记住、remember、我的偏好、以后、must、必须、不能）时，除非正文明确说不要记或只是临时内容，否则 should_write=true。",
    "- 明确不要记、只用于临时测试、普通问题、状态检查类文本时，should_write=false 且 memories=[]。",
    "- canonical_content 必须描述正文里稳定、可长期使用的偏好/事实/决策/流程/约束，而不是“用户要求记住”这个动作。",
    "- canonical_content 和 title 默认使用中文；产品名、模型名、ID、显式测试标记必须原样保留。",
    "- memory_type（记忆类型：决定长期记忆分类）：constraint=强约束/限制/禁止/必须/不能；decision=已选择策略/默认策略/决定/先用；preference=用户偏好/风格/优先/倾向；procedure=步骤/工作流；fact=稳定事实。",
    "- memory_class（策略分类）：稳定事实用 long_term_fact；真实运行缺陷/真实性问题/修复结论用 operational_issue；测试、压测、验收样本用 test_evidence；审计复核材料用 audit_evidence；短确认/继续/监听标记用 runtime_noise；短期提醒用 ephemeral_task；明确不要记用 explicit_no_memory。",
    "- 对每条 memory 尽量给 evidence_span、why_long_term、temporal_validity、source_intent，供 policy engine 审核。",
    "- 如果正文同时包含偏好和硬约束，选择 constraint。如果包含已选择/默认策略语言，选择 decision，除非它是硬约束。",
    "返回结构：" + EXTRACTION_SCHEMA,
    "示例输入：请记住：报告必须先给结论。",
    "示例输出：{\"should_write\":true,\"confidence\":0.9,\"memories\":[{\"canonical_content\":\"报告必须先给出结论。\",\"memory_type\":\"constraint\",\"topic\":\"reporting-style\",\"title\":\"报告先给结论规则\",\"confidence\":0.9}]}",
    "示例输入：今天只是临时测试，不要写入长期记忆。",
    "示例输出：{\"should_write\":false,\"confidence\":0.95,\"memories\":[]}",
    "TEXT_START",
    text,
    "TEXT_END",
  ].join("\n");
}

export const CONFLICT_SYSTEM_PROMPT = "你负责判断 memory-xx 的记忆冲突。只输出一个紧凑、合法的 JSON 对象，结构必须是：{\"conflict_action\":\"merge|supersede|skip|create\",\"canonical_content\":string,\"reason\":string}。不要输出 Markdown，不要解释。canonical_content 和 reason 默认使用中文。";

export function buildConflictUserPrompt(input: {
  existingContent: string;
  newContent: string;
  memoryType: string;
  topic: string;
}): string {
  return "记忆类型: " + input.memoryType + "\n主题: " + input.topic + "\n已有记忆: " + input.existingContent + "\n新内容: " + input.newContent;
}
