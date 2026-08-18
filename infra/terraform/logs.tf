resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name}/api"
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name}/worker"
  retention_in_days = 90
}

# The worker emits aggregate-only JSON health once per minute. Metrics are
# intentionally derived from logs so no research data crosses the monitoring
# boundary and the task role needs no CloudWatch metrics write permission.
resource "aws_cloudwatch_log_metric_filter" "domain_event_outbox_pending" {
  name           = "${var.name}-domain-event-outbox-pending"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"domain_event_outbox_health\" }"
  metric_transformation {
    name      = "DomainEventOutboxPending"
    namespace = "InteractiveResearchAgent"
    value     = "$.domain_event_outbox_pending"
  }
}

resource "aws_cloudwatch_log_metric_filter" "domain_event_outbox_oldest_age" {
  name           = "${var.name}-domain-event-outbox-oldest-age"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"domain_event_outbox_health\" }"
  metric_transformation {
    name      = "DomainEventOutboxOldestAgeSeconds"
    namespace = "InteractiveResearchAgent"
    value     = "$.domain_event_outbox_oldest_age_seconds"
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}/web"
  retention_in_days = 90
}
