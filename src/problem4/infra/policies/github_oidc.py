"""GitHub OIDC trust must name exact subjects: one branch, pull requests or one environment."""
from checkov.common.models.enums import CheckCategories, CheckResult
from checkov.terraform.checks.data.base_check import BaseDataCheck

ISSUER = "token.actions.githubusercontent.com"


class GithubOidcExactSubject(BaseDataCheck):
    def __init__(self):
        super().__init__(
            name="GitHub OIDC trust policies match the token subject exactly",
            id="CKV_P4_5",
            categories=[CheckCategories.IAM],
            supported_data=["aws_iam_policy_document"],
        )

    def scan_data_conf(self, conf):
        for statement in conf.get("statement", []):
            conditions = statement.get("condition", [])
            variables = [str(c.get("variable", [""])[0]) for c in conditions]
            if not any(v.startswith(ISSUER) for v in variables):
                continue
            # A wildcard subject would let any branch or fork assume the role.
            exact = [c for c in conditions if c.get("variable") == [f"{ISSUER}:sub"]
                     and c.get("test") == ["StringEquals"]]
            if not exact:
                return CheckResult.FAILED
        return CheckResult.PASSED


check = GithubOidcExactSubject()
