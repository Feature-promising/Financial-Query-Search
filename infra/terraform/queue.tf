resource "aws_sqs_queue" "research_runs_dlq" {
  name                      = "${var.name}-research-runs-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "research_runs" {
  name                       = "${var.name}-research-runs"
  visibility_timeout_seconds = 360
  redrive_policy = jsonencode({ deadLetterTargetArn = aws_sqs_queue.research_runs_dlq.arn, maxReceiveCount = 5 })
}

locals {
  alert_actions = var.alert_topic_arn == null ? [] : [var.alert_topic_arn]
}

# A visible backlog indicates throughput or downstream-provider degradation.
resource "aws_cloudwatch_metric_alarm" "research_runs_backlog" {
  alarm_name          = "${var.name}-research-runs-backlog"
  alarm_description   = "Research-run queue backlog exceeded its configured threshold."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 5
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.queue_backlog_alarm_threshold
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.research_runs.name }
  alarm_actions       = local.alert_actions
  ok_actions          = local.alert_actions
}

# Queue depth can remain low while individual runs are starved by a worker or
# external provider outage, so age is alerted independently of message count.
resource "aws_cloudwatch_metric_alarm" "research_runs_oldest_message" {
  alarm_name          = "${var.name}-research-runs-oldest-message"
  alarm_description   = "A research-run message has waited beyond the allowed processing latency."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.queue_oldest_message_alarm_seconds
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.research_runs.name }
  alarm_actions       = local.alert_actions
  ok_actions          = local.alert_actions
}

# Any DLQ arrival needs explicit triage before a run is manually replayed.
resource "aws_cloudwatch_metric_alarm" "research_runs_dlq_visible" {
  alarm_name          = "${var.name}-research-runs-dlq-visible"
  alarm_description   = "A research-run reached the dead-letter queue and requires audited triage."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.research_runs_dlq.name }
  alarm_actions       = local.alert_actions
  ok_actions          = local.alert_actions
}

# EventBridge is non-authoritative, but prolonged durable-outbox lag means
# downstream lifecycle/audit consumers have lost freshness and needs triage.
resource "aws_cloudwatch_metric_alarm" "domain_event_outbox_backlog" {
  alarm_name          = "${var.name}-domain-event-outbox-backlog"
  alarm_description   = "Committed domain events are accumulating before EventBridge delivery."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 5
  metric_name         = "DomainEventOutboxPending"
  namespace           = "InteractiveResearchAgent"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.domain_event_outbox_backlog_alarm_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alert_actions
  ok_actions          = local.alert_actions
}

resource "aws_cloudwatch_metric_alarm" "domain_event_outbox_oldest_age" {
  alarm_name          = "${var.name}-domain-event-outbox-oldest-age"
  alarm_description   = "The oldest committed domain event has exceeded its permitted delivery delay."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "DomainEventOutboxOldestAgeSeconds"
  namespace           = "InteractiveResearchAgent"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.domain_event_outbox_oldest_age_alarm_seconds
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alert_actions
  ok_actions          = local.alert_actions
}
