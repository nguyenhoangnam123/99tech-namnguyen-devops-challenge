data "aws_caller_identity" "current" {}

data "aws_ecr_repository" "backend" {
  name = "p4-backend"
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

resource "aws_lb" "backend" {
  name                       = "${local.name}-backend"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  idle_timeout               = 60
  enable_deletion_protection = !var.allow_destroy
}

resource "aws_lb_target_group" "backend" {
  name                 = "${local.name}-backend"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

# Requests that did not come through this environment's CloudFront
# distribution lack the shared secret header and get a 403.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.backend.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_secret.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/p4/${var.environment}/backend"
  retention_in_days = 365
}

# The image tag that is live. Deploys write it after a refresh succeeds;
# Terraform reads it back so its own launch template changes keep it.
resource "aws_ssm_parameter" "image_tag" {
  name           = "/p4/${var.environment}/backend/image-tag"
  type           = "String"
  insecure_value = var.first_image_tag
  lifecycle {
    ignore_changes = [insecure_value]
  }
}

resource "aws_launch_template" "backend" {
  name                   = "${local.name}-backend"
  image_id               = data.aws_ssm_parameter.al2023.insecure_value
  instance_type          = var.instance_type
  update_default_version = true
  user_data = base64encode(templatefile("${path.module}/user-data.sh", {
    region      = var.region
    registry    = split("/", data.aws_ecr_repository.backend.repository_url)[0]
    repository  = data.aws_ecr_repository.backend.repository_url
    log_group   = aws_cloudwatch_log_group.backend.name
    environment = var.environment
    group       = local.group_name
    hook        = local.launch_hook
  }))

  iam_instance_profile {
    arn = aws_iam_instance_profile.backend.arn
  }
  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.app.id]
    delete_on_termination       = true
  }
  # Tags are readable from inside the instance; user data reads ImageTag.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 16
      volume_type = "gp3"
      encrypted   = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "${local.name}-backend"
      environment = var.environment
      ImageTag    = aws_ssm_parameter.image_tag.insecure_value
    }
  }
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${local.name}-backend" }
  }
}

locals {
  group_name  = "${local.name}-backend"
  launch_hook = "wait-for-api"
}

resource "aws_autoscaling_group" "backend" {
  name                      = local.group_name
  min_size                  = var.instances.min
  desired_capacity          = var.instances.desired
  max_size                  = var.instances.max
  vpc_zone_identifier       = aws_subnet.public[*].id
  target_group_arns         = [aws_lb_target_group.backend.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 180
  default_instance_warmup   = 60

  launch_template {
    id      = aws_launch_template.backend.id
    version = aws_launch_template.backend.latest_version
  }
  # Launch before terminating, so capacity never drops during a refresh.
  instance_maintenance_policy {
    min_healthy_percentage = 100
    max_healthy_percentage = 200
  }
  # Deploys move the group to new template versions; see deploy-backend.sh.
  lifecycle {
    ignore_changes = [launch_template]
  }
}

# New instances stay out of the ALB until user data reports the API
# healthy. One that never does is abandoned, which fails the refresh.
resource "aws_autoscaling_lifecycle_hook" "wait_for_api" {
  name                   = local.launch_hook
  autoscaling_group_name = aws_autoscaling_group.backend.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_LAUNCHING"
  heartbeat_timeout      = 300
  default_result         = "ABANDON"
}

# Either alarm firing during a refresh makes it roll back on its own.
resource "aws_cloudwatch_metric_alarm" "backend_5xx" {
  alarm_name          = "${local.name}-backend-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = aws_lb.backend.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "backend_unhealthy" {
  alarm_name          = "${local.name}-backend-unhealthy"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = aws_lb.backend.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backend_instance" {
  name               = "${local.name}-backend-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

# Session Manager replaces SSH: no key pairs, no port 22.
resource "aws_iam_role_policy_attachment" "backend_ssm" {
  role       = aws_iam_role.backend_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "backend_instance" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [data.aws_ecr_repository.backend.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.backend.arn}:*"]
  }
  statement {
    actions   = ["autoscaling:CompleteLifecycleAction"]
    resources = ["arn:aws:autoscaling:${var.region}:${data.aws_caller_identity.current.account_id}:autoScalingGroup:*:autoScalingGroupName/${local.group_name}"]
  }
}

resource "aws_iam_role_policy" "backend_instance" {
  name   = "pull-image-and-log"
  role   = aws_iam_role.backend_instance.id
  policy = data.aws_iam_policy_document.backend_instance.json
}

resource "aws_iam_instance_profile" "backend" {
  name = "${local.name}-backend"
  role = aws_iam_role.backend_instance.name
}
