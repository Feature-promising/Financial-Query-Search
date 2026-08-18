resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"
  network_configuration { subnets = var.private_subnet_ids, security_groups = var.security_group_ids, assign_public_ip = false }
  load_balancer {
    target_group_arn = var.api_target_group_arn
    container_name   = "api"
    container_port   = 3001
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  network_configuration { subnets = var.private_subnet_ids, security_groups = var.security_group_ids, assign_public_ip = false }
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"
  network_configuration { subnets = var.private_subnet_ids, security_groups = var.security_group_ids, assign_public_ip = false }
  load_balancer {
    target_group_arn = var.web_target_group_arn
    container_name   = "web"
    container_port   = 3000
  }
}
