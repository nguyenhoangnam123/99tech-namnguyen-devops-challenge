package test

import (
	"path/filepath"
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Plans each stack against an empty local state and checks the
// properties the pipelines rely on. Needs read-only AWS access.
func TestEnvironmentPlan(t *testing.T) {
	dir := copyStack(t, "env")
	terraform.Init(t, &terraform.Options{TerraformDir: dir, NoColor: true})

	for _, environment := range []string{"staging", "production"} {
		t.Run(environment, func(t *testing.T) {
			plan := planEnvironment(t, dir, environment)
			checkRollout(t, plan, environment)
			checkEdge(t, plan)
			checkDeployRole(t, plan, environment)
		})
	}

	t.Run("rejects unknown environments", func(t *testing.T) {
		_, err := terraform.PlanE(t, &terraform.Options{
			TerraformDir: dir, NoColor: true,
			Vars: map[string]any{
				"environment": "dev", "region": region(), "first_image_tag": "plan-test",
				"vpc_cidr": "10.90.0.0/16", "instances": map[string]int{"min": 1, "desired": 1, "max": 2},
			},
		})
		require.ErrorContains(t, err, "environment must be")
	})
}

func planEnvironment(t *testing.T, dir, environment string) *terraform.PlanStruct {
	options := &terraform.Options{
		TerraformDir: dir, NoColor: true,
		VarFiles:     []string{varFile(t, environment+".tfvars")},
		Vars:         map[string]any{"region": region(), "first_image_tag": "plan-test"},
		PlanFilePath: filepath.Join(dir, environment+".tfplan"),
	}
	terraform.Plan(t, options)
	return terraform.ShowWithStruct(t, options)
}

// New instances must serve before old ones stop, and a release that
// never turns healthy must be abandoned rather than kept.
func checkRollout(t *testing.T, plan *terraform.PlanStruct, environment string) {
	group := attrs(t, plan, "aws_autoscaling_group.backend")
	policy := block(t, group, "instance_maintenance_policy")
	assert.EqualValues(t, 100, policy["min_healthy_percentage"])
	assert.EqualValues(t, 200, policy["max_healthy_percentage"])
	assert.Equal(t, "ELB", group["health_check_type"])
	assert.GreaterOrEqual(t, group["max_size"], 2*group["desired_capacity"].(float64), "a refresh doubles capacity")
	if environment == "production" {
		assert.GreaterOrEqual(t, group["min_size"], float64(2), "one instance per zone")
	}

	hook := attrs(t, plan, "aws_autoscaling_lifecycle_hook.wait_for_api")
	assert.Equal(t, "autoscaling:EC2_INSTANCE_LAUNCHING", hook["lifecycle_transition"])
	assert.Equal(t, "ABANDON", hook["default_result"])

	metadata := block(t, attrs(t, plan, "aws_launch_template.backend"), "metadata_options")
	assert.Equal(t, "required", metadata["http_tokens"])
	assert.Equal(t, "enabled", metadata["instance_metadata_tags"], "user data reads ImageTag")
	assert.EqualValues(t, 1, metadata["http_put_response_hop_limit"])
}

// Users reach the API only through CloudFront, over HTTPS.
func checkEdge(t *testing.T, plan *terraform.PlanStruct) {
	for address, resource := range plan.ResourcePlannedValuesMap {
		values := resource.AttributeValues
		switch resource.Type {
		case "aws_vpc_security_group_ingress_rule":
			for _, cidr := range []string{"cidr_ipv4", "cidr_ipv6"} {
				assert.Emptyf(t, values[cidr], "%s: ingress from a CIDR range", address)
				assert.Falsef(t, unknownAfterApply(plan, address, cidr), "%s: %s set at apply", address, cidr)
			}
		case "aws_security_group":
			assert.Emptyf(t, values["ingress"], "%s: inline ingress", address)
		case "aws_security_group_rule":
			assert.Equalf(t, "egress", values["type"], "%s: use aws_vpc_security_group_ingress_rule", address)
		case "aws_lb_listener_rule":
			assert.Truef(t, verifiesOrigin(values), "%s forwards without the CloudFront header", address)
		}
	}
	assert.NotEmpty(t, attrs(t, plan, "aws_vpc_security_group_ingress_rule.alb_from_cloudfront")["prefix_list_id"])
	attrs(t, plan, "aws_lb_listener_rule.from_cloudfront")

	assert.Equal(t, true, attrs(t, plan, "aws_lb.backend")["enable_deletion_protection"])
	deny := block(t, attrs(t, plan, "aws_lb_listener.http"), "default_action")
	assert.Equal(t, "fixed-response", deny["type"])
	assert.Equal(t, "403", block(t, deny, "fixed_response")["status_code"])

	cdn := attrs(t, plan, "aws_cloudfront_distribution.site")
	assert.Equal(t, "redirect-to-https", block(t, cdn, "default_cache_behavior")["viewer_protocol_policy"])
	api := block(t, cdn, "ordered_cache_behavior")
	assert.Equal(t, "/api/*", api["path_pattern"])
	assert.Equal(t, "backend", api["target_origin_id"])
	assert.Equal(t, "redirect-to-https", api["viewer_protocol_policy"])

	site := attrs(t, plan, "aws_s3_bucket_public_access_block.site")
	for _, setting := range []string{"block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"} {
		assert.Equal(t, true, site[setting], setting)
	}
}

// Only jobs in the matching GitHub environment may deploy.
func checkDeployRole(t *testing.T, plan *terraform.PlanStruct, environment string) {
	role := attrs(t, plan, "aws_iam_role.deploy")
	assert.Equal(t, "p4-github-deploy-"+environment, role["name"])
	assert.Equal(t, []any{subject + ":environment:" + environment},
		subjects(t, role["assume_role_policy"].(string)))
}

func TestSharedPlan(t *testing.T) {
	options := &terraform.Options{
		TerraformDir: copyStack(t, "shared"), NoColor: true,
		Vars: map[string]any{"region": region()},
	}
	options.PlanFilePath = filepath.Join(options.TerraformDir, "shared.tfplan")
	terraform.Init(t, options)
	terraform.Plan(t, options)
	plan := terraform.ShowWithStruct(t, options)

	registry := attrs(t, plan, "aws_ecr_repository.backend")
	assert.Equal(t, "IMMUTABLE", registry["image_tag_mutability"], "a tag names one build forever")
	assert.Equal(t, true, block(t, registry, "image_scanning_configuration")["scan_on_push"])

	github := attrs(t, plan, "aws_iam_openid_connect_provider.github")
	assert.Equal(t, "https://token.actions.githubusercontent.com", github["url"])
	assert.Equal(t, []any{"sts.amazonaws.com"}, github["client_id_list"])

	versioning := block(t, attrs(t, plan, "aws_s3_bucket_versioning.artifacts"), "versioning_configuration")
	assert.Equal(t, "Enabled", versioning["status"])

	for _, name := range []string{"build", "plan"} {
		change := plan.ResourceChangesMap["aws_iam_role."+name]
		require.NotNilf(t, change, "role %s", name)
		assert.True(t, change.Change.Actions.Create())
		assert.EqualValues(t, 3600, attrs(t, plan, "aws_iam_role."+name)["max_session_duration"])
	}
}
