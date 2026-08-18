# Domain events contain metadata only; consumers retrieve authorized details
# from the API/warehouse rather than receiving questions or evidence in transit.
resource "aws_cloudwatch_event_bus" "research_domain_events" {
  name = "${var.name}-domain-events"
}
