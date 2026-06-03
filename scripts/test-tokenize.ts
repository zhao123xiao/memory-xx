import { tokenizeRecallQuery } from "../app/recall/metadata-filter-builder";

const queries = [
  "我的安全边界是什么",
  "当前记忆系统的主账是什么",
  "embedding 主链用的什么模型",
  "当前有哪些活跃项目",
  "rollback 策略是什么",
  "协作偏好是什么",
  "子Agent输出怎么处理",
  "记忆框架的满分定义是什么",
  "旧记忆迁移的方案是什么",
  "当前模型配置是什么",
  "定时任务和健康检查有哪些",
  "今天做了什么",
  "数据同步脚本怎么用"
];

for (const q of queries) {
  const terms = tokenizeRecallQuery(q);
  const likePatterns = terms.length > 0
    ? terms.map(t => `%${t}%`)
    : [`%${q.toLowerCase()}%`];
  console.log(`${q}`);
  console.log(`  terms: ${JSON.stringify(terms)}`);
  console.log(`  LIKE:  ${JSON.stringify(likePatterns)}`);
  console.log();
}
