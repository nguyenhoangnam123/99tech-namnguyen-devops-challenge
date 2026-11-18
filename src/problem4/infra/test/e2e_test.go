package test

import (
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	http_helper "github.com/gruntwork-io/terratest/modules/http-helper"
	"github.com/gruntwork-io/terratest/modules/random"
	"github.com/gruntwork-io/terratest/modules/terraform"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Applies a throwaway environment, checks it the way users reach it, then
// destroys it. Needs admin credentials and an image tag that exists in ECR.
func TestEnvironmentEndToEnd(t *testing.T) {
	tag := os.Getenv("P4_E2E_IMAGE_TAG")
	if tag == "" {
		t.Skip("set P4_E2E_IMAGE_TAG to an image in ECR to run")
	}
	options := &terraform.Options{
		TerraformDir: copyStack(t, "env"), NoColor: true,
		Vars: map[string]any{
			"environment":     "e2e-" + strings.ToLower(random.UniqueId()),
			"region":          region(),
			"vpc_cidr":        "10.90.0.0/16",
			"instances":       map[string]int{"min": 1, "desired": 1, "max": 2},
			"first_image_tag": tag,
			"allow_destroy":   true,
		},
	}
	defer terraform.Destroy(t, options)
	terraform.InitAndApply(t, options)
	url := terraform.Output(t, options, "url")

	t.Run("CloudFront serves the API at the requested version", func(t *testing.T) {
		http_helper.HttpGetWithRetryWithCustomValidation(t, url+"/api/version", nil, 60, 10*time.Second,
			func(status int, body string) bool { return status == http.StatusOK && strings.Contains(body, tag) })
	})

	t.Run("plain HTTP is redirected to HTTPS", func(t *testing.T) {
		client := &http.Client{
			Timeout:       10 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		response, err := client.Get(strings.Replace(url, "https://", "http://", 1) + "/api/version")
		require.NoError(t, err)
		defer response.Body.Close()
		assert.Equal(t, http.StatusMovedPermanently, response.StatusCode)
		assert.True(t, strings.HasPrefix(response.Header.Get("Location"), "https://"))
	})

	t.Run("the load balancer refuses direct connections", func(t *testing.T) {
		alb := terraform.Output(t, options, "alb_dns_name")
		connection, err := net.DialTimeout("tcp", alb+":80", 5*time.Second)
		if err == nil {
			connection.Close()
		}
		assert.Error(t, err, "only CloudFront's address ranges may connect")
	})
}
