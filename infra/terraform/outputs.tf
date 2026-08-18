output "research_run_queue_url" { value = aws_sqs_queue.research_runs.url }
output "research_run_queue_arn" { value = aws_sqs_queue.research_runs.arn }
output "research_domain_event_bus_name" { value = aws_cloudwatch_event_bus.research_domain_events.name }
output "research_domain_event_bus_arn" { value = aws_cloudwatch_event_bus.research_domain_events.arn }
output "database_migration_task_definition_arn" { value = aws_ecs_task_definition.database_migration.arn }
output "web_service_name" { value = aws_ecs_service.web.name }
