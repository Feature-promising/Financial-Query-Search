import { readFile } from "node:fs/promises";

const [queue, variables, tasks, services, events, schedule] = await Promise.all([
  readFile(new URL("../infra/terraform/queue.tf", import.meta.url), "utf8"),
  readFile(new URL("../infra/terraform/variables.tf", import.meta.url), "utf8"),
  readFile(new URL("../infra/terraform/tasks.tf", import.meta.url), "utf8"),
  readFile(new URL("../infra/terraform/services.tf", import.meta.url), "utf8"),
  readFile(new URL("../infra/terraform/events.tf", import.meta.url), "utf8"),
  readFile(new URL("../infra/terraform/schedule.tf", import.meta.url), "utf8"),
]);

for (const resource of ["research_runs_backlog", "research_runs_oldest_message", "research_runs_dlq_visible", "domain_event_outbox_backlog", "domain_event_outbox_oldest_age"]) {
  if (!queue.includes(`aws_cloudwatch_metric_alarm" "${resource}"`)) throw new Error(`Terraform is missing ${resource} alarm`);
}
for (const metric of ["ApproximateNumberOfMessagesVisible", "ApproximateAgeOfOldestMessage"]) {
  if (!queue.includes(`metric_name         = "${metric}"`)) throw new Error(`Terraform is missing ${metric} coverage`);
}
for (const variable of ["alert_topic_arn", "queue_backlog_alarm_threshold", "queue_oldest_message_alarm_seconds", "domain_event_outbox_backlog_alarm_threshold", "domain_event_outbox_oldest_age_alarm_seconds", "api_cors_allowed_origins", "web_image", "api_target_group_arn", "web_target_group_arn", "worker_otlp_traces_endpoint", "worker_stop_timeout_seconds", "worker_sec_max_response_bytes", "worker_bedrock_embedding_input_cost_per_1k_usd", "api_task_role_arn", "worker_task_role_arn", "sec_ingestion_task_role_arn", "memory_retention_task_role_arn", "migration_task_role_arn", "api_secrets", "worker_secrets", "sec_ingestion_secrets", "memory_retention_secrets", "migration_secrets"]) {
  if (!variables.includes(`variable "${variable}"`)) throw new Error(`Terraform is missing ${variable} configuration`);
}
if (!queue.includes("treat_missing_data  = \"notBreaching\"")) throw new Error("SQS alarms must avoid false alarms for idle queues");
if (!tasks.includes('aws_ecs_task_definition" "web"') || !services.includes('aws_ecs_service" "web"')) throw new Error("Terraform must define the Next.js Web Fargate service");
if (!services.includes("target_group_arn = var.api_target_group_arn") || !services.includes("target_group_arn = var.web_target_group_arn")) throw new Error("API and Web services must attach to supplied load-balancer target groups");
if (!tasks.includes('name = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"') || !tasks.includes("value = var.worker_otlp_traces_endpoint")) throw new Error("Worker task must receive the OTLP trace collector endpoint");
if (!tasks.includes('name = "SEC_MAX_RESPONSE_BYTES"') || !tasks.includes("value = tostring(var.worker_sec_max_response_bytes)")) throw new Error("Worker task must receive the bounded SEC response-size configuration");
if (!tasks.includes('name = "BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD"') || !tasks.includes("value = tostring(var.worker_bedrock_embedding_input_cost_per_1k_usd)")) throw new Error("Worker task must receive embedding cost configuration");
if (!variables.includes('"TOOL_MANIFEST_CATALOG_JSON"') || !variables.includes('toset(keys(var.api_secrets))') || !variables.includes('toset(keys(var.worker_secrets))')) {
  throw new Error("Terraform must require the administrator-approved tool catalog for both API and Worker");
}
if (!variables.includes('"REDSHIFT_SECRET_ARN"') || !variables.includes('toset(keys(var.worker_secrets))')) {
  throw new Error("Terraform must require the Redshift Serverless secret for the Worker");
}
if (!variables.includes('variable "migration_secrets"') || !variables.includes('toset(keys(var.migration_secrets)) == toset(["DATABASE_URL"])')) {
  throw new Error("Terraform must require a dedicated database secret map for migrations");
}
if (!tasks.includes('name = "MAX_ACTIVE_RUNS_PER_USER"') || !tasks.includes('name = "MAX_ACTIVE_RUNS_PER_ORGANIZATION"') || !variables.includes('variable "api_max_active_runs_per_user"') || !variables.includes('variable "api_max_active_runs_per_organization"')) throw new Error("API task must receive bounded active-run quota configuration");
if (!events.includes('aws_cloudwatch_event_bus" "research_domain_events"')) throw new Error("Terraform must define the domain EventBridge bus");
if (!tasks.includes('name = "EVENTBRIDGE_EVENT_BUS_NAME"') || !tasks.includes("aws_cloudwatch_event_bus.research_domain_events.name")) throw new Error("Worker task must receive the domain EventBridge bus name");
if (!tasks.includes("stopTimeout = var.worker_stop_timeout_seconds")) throw new Error("Worker task must allow its shutdown-abstention path to flush");
if (!services.includes("deployment_minimum_healthy_percent = 100") || !services.includes("deployment_maximum_percent         = 200")) throw new Error("Worker service must roll out replacement capacity before draining workers");
for (const command of [
  '["node", "dist/server.js"]',
  '["node", "dist/main.js"]',
  '["node", "apps/web/server.js"]',
  '["node", "dist/sec-ingestion-main.js"]',
  '["node", "dist/memory-retention-main.js"]',
  '["node", "dist/migrate-main.js"]'
]) {
  if (!tasks.includes(command)) throw new Error(`Terraform must use the deployed runtime command ${command}`);
}
if (tasks.includes("apps/api/dist") || tasks.includes("apps/worker/dist") || tasks.includes("next/dist/bin/next")) {
  throw new Error("Terraform commands must match the minimized production image layout");
}
if (!tasks.includes('aws_ecs_task_definition" "memory_retention"') || !schedule.includes('aws_cloudwatch_event_rule" "memory_retention"') || !schedule.includes("aws_ecs_task_definition.memory_retention.arn") || !variables.includes('variable "memory_retention_batch_size"')) {
  throw new Error("Terraform must schedule the bounded memory-retention task");
}
if (tasks.includes("var.task_role_arn")) throw new Error("ECS tasks must not fall back to a shared application task role");
if (!tasks.includes("var.migration_secrets") || tasks.includes('migration_container = merge(local.worker_container') || tasks.includes('sec_ingestion_container = merge(local.worker_container') || tasks.includes('memory_retention_container = merge(local.worker_container')) {
  throw new Error("scheduled and migration tasks must have their own narrow secret maps and container contracts");
}
for (const required of ["var.sec_ingestion_secrets", "var.memory_retention_secrets", 'name = "AWS_REGION"', "value = var.aws_region"]) {
  if (!tasks.includes(required)) throw new Error(`Terraform is missing scoped task configuration: ${required}`);
}
for (const [task, role] of [["api", "api_task_role_arn"], ["worker", "worker_task_role_arn"], ["sec_ingestion", "sec_ingestion_task_role_arn"], ["memory_retention", "memory_retention_task_role_arn"], ["database_migration", "migration_task_role_arn"]]) {
  const taskStart = tasks.indexOf(`resource \"aws_ecs_task_definition\" \"${task}\"`);
  const nextTask = tasks.indexOf('resource "aws_ecs_task_definition"', taskStart + 1);
  const definition = tasks.slice(taskStart, nextTask === -1 ? undefined : nextTask);
  if (taskStart < 0 || !definition.includes(`task_role_arn            = var.${role}`)) throw new Error(`${task} must use its dedicated ${role}`);
}
const logs = await readFile(new URL("../infra/terraform/logs.tf", import.meta.url), "utf8");
for (const metric of ["DomainEventOutboxPending", "DomainEventOutboxOldestAgeSeconds"]) {
  if (!logs.includes(`name      = "${metric}"`)) throw new Error(`Terraform is missing ${metric} log metric`);
}

console.log("Terraform queue alert contract validated");
