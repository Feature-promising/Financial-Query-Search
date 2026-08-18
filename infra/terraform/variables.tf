variable "aws_region" { type = string }
variable "name" { type = string, default = "interactive-research-agent" }
variable "ecs_cluster_arn" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "task_execution_role_arn" { type = string }
# These roles are intentionally separate. Their policies are owned by the
# platform IAM layer and must grant only the capabilities of this workload.
variable "api_task_role_arn" { type = string }
variable "worker_task_role_arn" { type = string }
variable "sec_ingestion_task_role_arn" { type = string }
variable "memory_retention_task_role_arn" { type = string }
variable "migration_task_role_arn" { type = string }
variable "eventbridge_invoke_role_arn" { type = string }
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "web_image" { type = string }
variable "api_target_group_arn" { type = string }
variable "web_target_group_arn" { type = string }
variable "api_cors_allowed_origins" {
  type = string
  validation { condition = length(trimspace(var.api_cors_allowed_origins)) > 0, error_message = "api_cors_allowed_origins must contain at least one deployed web origin." }
}
variable "api_desired_count" { type = number, default = 2 }
variable "api_max_active_runs_per_user" {
  type    = number
  default = 2
  validation { condition = var.api_max_active_runs_per_user >= 1 && var.api_max_active_runs_per_user <= 20, error_message = "api_max_active_runs_per_user must be between 1 and 20." }
}
variable "api_max_active_runs_per_organization" {
  type    = number
  default = 10
  validation { condition = var.api_max_active_runs_per_organization >= 1 && var.api_max_active_runs_per_organization <= 200, error_message = "api_max_active_runs_per_organization must be between 1 and 200." }
}
variable "worker_desired_count" { type = number, default = 1 }
variable "worker_stop_timeout_seconds" {
  type    = number
  default = 120
  validation {
    condition     = var.worker_stop_timeout_seconds >= 30 && var.worker_stop_timeout_seconds <= 120
    error_message = "worker_stop_timeout_seconds must be between 30 and 120 seconds for Fargate."
  }
}
variable "web_desired_count" { type = number, default = 2 }
variable "api_secrets" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.api_secrets)) == toset(["DATABASE_URL", "REDIS_URL", "BEDROCK_EMBEDDING_MODEL_ID", "OPENSEARCH_ENDPOINT", "OPENSEARCH_INDEX", "EVIDENCE_S3_BUCKET", "NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "OIDC_ISSUER", "OIDC_AUDIENCE", "TOOL_MANIFEST_CATALOG_JSON"])
    error_message = "api_secrets must inject its persistence, identity, evidence-cleanup, and approved-tool configuration."
  }
}
variable "worker_secrets" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.worker_secrets)) == toset(["DATABASE_URL", "REDIS_URL", "BEDROCK_MODEL_ID", "BEDROCK_EMBEDDING_MODEL_ID", "BEDROCK_INPUT_COST_PER_1K_USD", "BEDROCK_OUTPUT_COST_PER_1K_USD", "OPENSEARCH_ENDPOINT", "OPENSEARCH_INDEX", "EVIDENCE_S3_BUCKET", "REDSHIFT_WORKGROUP", "REDSHIFT_DATABASE", "REDSHIFT_SECRET_ARN", "MARKET_DATA_LICENSE", "NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "SEC_USER_AGENT", "TOOL_MANIFEST_CATALOG_JSON"])
    error_message = "worker_secrets must inject only the Agent runtime's persistence, model, retrieval, warehouse, graph, source, and approved-tool configuration."
  }
}
variable "sec_ingestion_secrets" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.sec_ingestion_secrets)) == toset(["DATABASE_URL", "SEC_USER_AGENT", "BEDROCK_EMBEDDING_MODEL_ID", "OPENSEARCH_ENDPOINT", "OPENSEARCH_INDEX", "EVIDENCE_S3_BUCKET", "NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "SEC_INGEST_TENANT_ID", "SEC_INGEST_TICKERS"])
    error_message = "sec_ingestion_secrets must inject only SEC source, target, persistence, embedding, evidence-index, and graph configuration."
  }
}
variable "memory_retention_secrets" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.memory_retention_secrets)) == toset(["DATABASE_URL", "BEDROCK_EMBEDDING_MODEL_ID", "OPENSEARCH_ENDPOINT", "OPENSEARCH_INDEX", "EVIDENCE_S3_BUCKET", "NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD"])
    error_message = "memory_retention_secrets must inject only persistence, embedding, evidence-index, and graph configuration."
  }
}
variable "migration_secrets" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.migration_secrets)) == toset(["DATABASE_URL"])
    error_message = "migration_secrets must inject DATABASE_URL from the approved database secret."
  }
}
variable "worker_otlp_traces_endpoint" {
  type = string
  validation {
    condition     = can(regex("^https?://", var.worker_otlp_traces_endpoint))
    error_message = "worker_otlp_traces_endpoint must be an HTTP(S) OTLP trace collector endpoint."
  }
}
variable "worker_sec_max_response_bytes" {
  type    = number
  default = 5242880
  validation { condition = var.worker_sec_max_response_bytes >= 65536 && var.worker_sec_max_response_bytes <= 5242880, error_message = "worker_sec_max_response_bytes must be between 64 KiB and 5 MiB." }
}
variable "worker_bedrock_embedding_input_cost_per_1k_usd" {
  type = number
  validation { condition = var.worker_bedrock_embedding_input_cost_per_1k_usd >= 0, error_message = "worker_bedrock_embedding_input_cost_per_1k_usd must be non-negative." }
}
variable "sec_ingestion_schedule" { type = string, default = "cron(0 2 ? * MON-FRI *)" }
variable "memory_retention_schedule" { type = string, default = "cron(0 3 ? * * *)" }
variable "memory_retention_batch_size" {
  type    = number
  default = 100
  validation { condition = var.memory_retention_batch_size >= 1 && var.memory_retention_batch_size <= 1000, error_message = "memory_retention_batch_size must be between 1 and 1000." }
}

# The platform owning this stack owns notification routing and responder policy.
# When unset, alarms remain visible in CloudWatch without creating an SNS topic.
variable "alert_topic_arn" { type = string, default = null, nullable = true }
variable "queue_backlog_alarm_threshold" {
  type = number
  default = 10
  validation { condition = var.queue_backlog_alarm_threshold >= 1, error_message = "queue_backlog_alarm_threshold must be at least one message." }
}
variable "queue_oldest_message_alarm_seconds" {
  type = number
  default = 300
  validation { condition = var.queue_oldest_message_alarm_seconds >= 60, error_message = "queue_oldest_message_alarm_seconds must be at least 60 seconds." }
}
variable "domain_event_outbox_backlog_alarm_threshold" {
  type = number
  default = 50
  validation { condition = var.domain_event_outbox_backlog_alarm_threshold >= 1, error_message = "domain_event_outbox_backlog_alarm_threshold must be at least one event." }
}
variable "domain_event_outbox_oldest_age_alarm_seconds" {
  type = number
  default = 300
  validation { condition = var.domain_event_outbox_oldest_age_alarm_seconds >= 60, error_message = "domain_event_outbox_oldest_age_alarm_seconds must be at least 60 seconds." }
}
