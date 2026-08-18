resource "aws_cloudwatch_event_rule" "sec_ingestion" {
  name                = "${var.name}-sec-ingestion"
  schedule_expression = var.sec_ingestion_schedule
}

resource "aws_cloudwatch_event_target" "sec_ingestion" {
  rule     = aws_cloudwatch_event_rule.sec_ingestion.name
  target_id = "sec-ingestion"
  arn      = var.ecs_cluster_arn
  role_arn = var.eventbridge_invoke_role_arn
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.sec_ingestion.arn
    launch_type         = "FARGATE"
    task_count          = 1
    network_configuration { subnets = var.private_subnet_ids, security_groups = var.security_group_ids, assign_public_ip = false }
  }
}

resource "aws_cloudwatch_event_rule" "memory_retention" {
  name                = "${var.name}-memory-retention"
  schedule_expression = var.memory_retention_schedule
}

resource "aws_cloudwatch_event_target" "memory_retention" {
  rule      = aws_cloudwatch_event_rule.memory_retention.name
  target_id = "memory-retention"
  arn       = var.ecs_cluster_arn
  role_arn  = var.eventbridge_invoke_role_arn
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.memory_retention.arn
    launch_type         = "FARGATE"
    task_count          = 1
    network_configuration { subnets = var.private_subnet_ids, security_groups = var.security_group_ids, assign_public_ip = false }
  }
}
