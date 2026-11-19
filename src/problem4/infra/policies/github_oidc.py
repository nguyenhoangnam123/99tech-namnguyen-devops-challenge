"""GitHub OIDC trust must name exact subjects: one branch, pull requests or one environment."""
from checkov.common.models.enums import CheckCategories, CheckResult
from checkov.terraform.checks.data.base_check import BaseDataCheck

ISSUER = "token.actions.githubusercontent.com"


def _values(block, key):
    value = block.get(key, [])
    flat = value[0] if len(value) == 1 and isinstance(value[0], list) else value
    return [str(v) for v in flat]


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
            if "sts:AssumeRoleWithWebIdentity" not in _values(statement, "actions"):
                continue
            conditions = statement.get("condition", [])
            pinned = {_values(c, "variable")[0] for c in conditions
                      if _values(c, "test") == ["StringEquals"] and _values(c, "variable")}
            # Without both, any repository or any branch could assume the role.
            if not {f"{ISSUER}:aud", f"{ISSUER}:sub"} <= pinned:
                return CheckResult.FAILED
        return CheckResult.PASSED


check = GithubOidcExactSubject()
