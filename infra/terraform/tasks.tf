locals {
  api_container = {
    name      = "api"
    image     = var.api_image
    essential = true
    command   = ["node", "dist/server.js"]
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]
    environment = [{ name = "NODE_ENV", value = "production" }, { name = "PERSISTENCE_MODE", value = "postgres" }, { name = "AWS_REGION", value = var.aws_region }, { name = "CORS_ALLOWED_ORIGINS", value = var.api_cors_allowed_origins }, { name = "SQS_RESEARCH_RUN_QUEUE_URL", value = aws_sqs_queue.research_runs.url }, { name = "MAX_ACTIVE_RUNS_PER_USER", value = tostring(var.api_max_active_runs_per_user) }, { name = "MAX_ACTIVE_RUNS_PER_ORGANIZATION", value = tostring(var.api_max_active_runs_per_organization) }]
    secrets = [for name, value_from in var.api_secrets : { name = name, valueFrom = value_from }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs" } }
  }
  worker_container = {
    name      = "worker"
    image     = var.worker_image
    essential = true
    command   = ["node", "dist/main.js"]
    stopTimeout = var.worker_stop_timeout_seconds
    environment = [{ name = "NODE_ENV", value = "production" }, { name = "PERSISTENCE_MODE", value = "postgres" }, { name = "AWS_REGION", value = var.aws_region }, { name = "SQS_RESEARCH_RUN_QUEUE_URL", value = aws_sqs_queue.research_runs.url }, { name = "EVENTBRIDGE_EVENT_BUS_NAME", value = aws_cloudwatch_event_bus.research_domain_events.name }, { name = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value = var.worker_otlp_traces_endpoint }, { name = "SEC_MAX_RESPONSE_BYTES", value = tostring(var.worker_sec_max_response_bytes) }, { name = "BEDROCK_EMBEDDING_INPUT_COST_PER_1K_USD", value = tostring(var.worker_bedrock_embedding_input_cost_per_1k_usd) }]
    secrets = [for name, value_from in var.worker_secrets : { name = name, valueFrom = value_from }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs" } }
  }
  web_container = {
    name      = "web"
    image     = var.web_image
    essential = true
    command   = ["node", "apps/web/server.js"]
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [{ name = "NODE_ENV", value = "production" }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.web.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs" } }
  }
  # Scheduled maintenance tasks are intentionally separate from the Agent
  # Worker: each receives only its source/retention dependencies.
  sec_ingestion_container = {
    name      = "sec-ingestion"
    image     = var.worker_image
    essential = true
    command   = ["node", "dist/sec-ingestion-main.js"]
    environment = [{ name = "NODE_ENV", value = "production" }, { name = "PERSISTENCE_MODE", value = "postgres" }, { name = "AWS_REGION", value = var.aws_region }, { name = "SEC_MAX_RESPONSE_BYTES", value = tostring(var.worker_sec_max_response_bytes) }]
    secrets = [for name, value_from in var.sec_ingestion_secrets : { name = name, valueFrom = value_from }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs-sec-ingestion" } }
  }
  memory_retention_container = {
    name      = "memory-retention"
    image     = var.worker_image
    essential = true
    command   = ["node", "dist/memory-retention-main.js"]
    environment = [{ name = "NODE_ENV", value = "production" }, { name = "PERSISTENCE_MODE", value = "postgres" }, { name = "AWS_REGION", value = var.aws_region }, { name = "MEMORY_RETENTION_BATCH_SIZE", value = tostring(var.memory_retention_batch_size) }]
    secrets = [for name, value_from in var.memory_retention_secrets : { name = name, valueFrom = value_from }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs-memory-retention" } }
  }
  # Schema migration has no Agent, model, retrieval, or tool runtime. Keep its
  # ECS definition separate so it receives only DATABASE_URL via its own secret
  # map rather than inheriting the Worker container's broad runtime contract.
  migration_container = {
    name      = "database-migration"
    image     = var.worker_image
    essential = true
    command   = ["node", "dist/migrate-main.js"]
    environment = [{ name = "NODE_ENV", value = "production" }, { name = "PERSISTENCE_MODE", value = "postgres" }]
    secrets = [for name, value_from in var.migration_secrets : { name = name, valueFrom = value_from }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs-migration" } }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.api_task_role_arn
  container_definitions    = jsonencode([local.api_container])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.worker_task_role_arn
  container_definitions    = jsonencode([local.worker_container])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.task_execution_role_arn
  container_definitions    = jsonencode([local.web_container])
}

resource "aws_ecs_task_definition" "sec_ingestion" {
  family                   = "${var.name}-sec-ingestion"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.sec_ingestion_task_role_arn
  container_definitions    = jsonencode([local.sec_ingestion_container])
}

resource "aws_ecs_task_definition" "memory_retention" {
  family                   = "${var.name}-memory-retention"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.memory_retention_task_role_arn
  container_definitions    = jsonencode([local.memory_retention_container])
}

# This task is intentionally not a service or scheduled job. Run it once per
# deployment before updating API and Worker services; the runner serializes
# concurrent invocations with a PostgreSQL advisory lock.
resource "aws_ecs_task_definition" "database_migration" {
  family                   = "${var.name}-database-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.migration_task_role_arn
  container_definitions    = jsonencode([local.migration_container])
}
