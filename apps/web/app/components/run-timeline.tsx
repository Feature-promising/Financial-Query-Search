"use client";

import type { ResearchEvent } from "../lib/research-types";

const labels: Record<string, string> = {
  run_started: "研究已启动", run_paused: "研究已在队列中暂停", run_resumed: "研究已重新进入队列", intent_ready: "意图已识别", plan_ready: "研究计划已生成",
  task_started: "任务执行中", tool_completed: "工具调用完成", evidence_ready: "证据已就绪",
  claim_delta: "研究结论生成中",
  critic_result: "质量审查完成", completed: "研究完成", abstained: "已拒答", failed: "运行失败",
};

export function RunTimeline({ events }: { events: ResearchEvent[] }) {
  const visible = events.filter((event) => event.type !== "claim_delta");
  return <section className="timeline"><h3>研究过程</h3>{visible.map((event, index) => <div className={`timeline-event ${event.type}`} key={`${event.type}-${index}`}>
    <strong>{labels[event.type] ?? event.type}</strong><span>{summary(event)}</span>
  </div>)}</section>;
}

function summary(event: ResearchEvent): string {
  if (typeof event.payload.title === "string") return event.payload.title;
  if (typeof event.payload.summary === "string") return event.payload.summary;
  if (typeof event.payload.reason === "string") return event.payload.reason;
  if (typeof event.payload.message === "string") return event.payload.message;
  if (typeof event.payload.count === "number") return `${event.payload.count} 条证据`;
  return "";
}
