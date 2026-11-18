package test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/gruntwork-io/terratest/modules/terraform"
	test_structure "github.com/gruntwork-io/terratest/modules/test-structure"
	"github.com/stretchr/testify/require"
)

const repository = "nguyenhoangnam123/99tech-namnguyen-devops-challenge"

func region() string {
	if r := os.Getenv("AWS_REGION"); r != "" {
		return r
	}
	return "ap-southeast-1"
}

// copyStack copies one stack to a temp folder with local state, so tests
// never read or lock the real state bucket.
func copyStack(t *testing.T, stack string) string {
	dir := test_structure.CopyTerraformFolderToTemp(t, "..", stack)
	override := "terraform {\n  backend \"local\" {}\n}\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "backend_override.tf"), []byte(override), 0o600))
	return dir
}

func varFile(t *testing.T, name string) string {
	path, err := filepath.Abs(filepath.Join("..", "env", name))
	require.NoError(t, err)
	return path
}

func attrs(t *testing.T, plan *terraform.PlanStruct, address string) map[string]any {
	resource, ok := plan.ResourcePlannedValuesMap[address]
	require.Truef(t, ok, "%s is not in the plan", address)
	return resource.AttributeValues
}

// block returns the only element of a nested block such as metadata_options.
func block(t *testing.T, values map[string]any, name string) map[string]any {
	list, ok := values[name].([]any)
	require.Truef(t, ok && len(list) == 1, "%s: want one block, got %v", name, values[name])
	return list[0].(map[string]any)
}

func resourcesOfType(plan *terraform.PlanStruct, kind string) []map[string]any {
	var found []map[string]any
	for _, resource := range plan.ResourcePlannedValuesMap {
		if resource.Type == kind {
			found = append(found, resource.AttributeValues)
		}
	}
	return found
}

type trustPolicy struct {
	Statement []struct {
		Condition map[string]map[string]any
	}
}

// subjects returns the GitHub OIDC subjects a role trust policy accepts.
func subjects(t *testing.T, policy string) []any {
	var trust trustPolicy
	require.NoError(t, json.Unmarshal([]byte(policy), &trust))
	require.Len(t, trust.Statement, 1)
	equals := trust.Statement[0].Condition["StringEquals"]
	require.Equal(t, "sts.amazonaws.com", equals["token.actions.githubusercontent.com:aud"])
	switch sub := equals["token.actions.githubusercontent.com:sub"].(type) {
	case string:
		return []any{sub}
	case []any:
		return sub
	default:
		t.Fatalf("trust policy does not pin the OIDC subject: %s", policy)
		return nil
	}
}
