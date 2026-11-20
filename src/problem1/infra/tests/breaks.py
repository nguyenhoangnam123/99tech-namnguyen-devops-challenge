#!/usr/bin/env python3
"""Breaks the stack one property at a time, in a scratch copy, and checks
that the named test run or Checkov rule fails. Usage: tests/breaks.py [name...]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

STACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKOV = "bridgecrew/checkov:3.4.5"

# (name, file, text to replace, replacement, what must fail)
BREAKS = [
    ("subnets placed by sorted name, not zone ID", "network.tf",
     "zones      = { for i, id in var.zone_ids : local.zone_names[id] => i }",
     "zones      = { for i, name in slice(sort(values(local.zone_names)), 0, length(var.zone_ids)) : name => i }",
     "zones_follow_their_ids"),
    ("S3 endpoint on the isolated route table", "network.tf",
     "route_table_ids   = [for table in aws_route_table.private : table.id]",
     "route_table_ids   = concat([for table in aws_route_table.private : table.id], [aws_route_table.isolated.id])",
     "data_subnets_have_no_route_out"),
    ("isolated subnets on the public route table", "network.tf",
     "  subnet_id      = each.value.id\n  route_table_id = aws_route_table.isolated.id",
     "  subnet_id      = each.value.id\n  route_table_id = aws_route_table.public.id",
     "data_subnets_have_no_route_out"),
    ("inline internet route on the private tables", "network.tf",
     'resource "aws_route_table" "private" {\n  for_each = local.zones\n  vpc_id   = aws_vpc.main.id',
     'resource "aws_route_table" "private" {\n  for_each = local.zones\n  vpc_id   = aws_vpc.main.id\n'
     '  route {\n    cidr_block = "0.0.0.0/0"\n    gateway_id = aws_internet_gateway.main.id\n  }',
     "data_subnets_have_no_route_out"),
    ("a NAT gateway and a default route through it", "network.tf",
     "# No routes beyond the VPC's local route.",
     'resource "aws_nat_gateway" "back" {\n  subnet_id = aws_subnet.public["ap-southeast-1a"].id\n}\n\n'
     'resource "aws_route" "back" {\n  route_table_id         = aws_route_table.private["ap-southeast-1a"].id\n'
     '  destination_cidr_block = "0.0.0.0/0"\n  nat_gateway_id         = aws_nat_gateway.back.id\n}\n\n'
     "# No routes beyond the VPC's local route.",
     "checkov:CKV2_P1_1,checkov:CKV2_P1_2"),
    ("workload HTTPS to the internet", "security-groups.tf",
     "  referenced_security_group_id = aws_security_group.endpoints.id",
     '  cidr_ipv4                    = "0.0.0.0/0"',
     "tasks_reach_aws_only_through_endpoints,checkov:CKV2_P1_3"),
    ("interface endpoint without private DNS", "network.tf",
     "  private_dns_enabled = true", "  private_dns_enabled = false",
     "tasks_reach_aws_only_through_endpoints"),
    ("interface endpoints open to other accounts", "network.tf",
     'Condition = { StringEquals = { "aws:PrincipalAccount" = local.account } }', "",
     "tasks_reach_aws_only_through_endpoints"),
    ("S3 endpoint open to any bucket", "network.tf",
     'Condition = { StringEquals = { "aws:ResourceAccount" = local.account } }', "",
     "tasks_reach_aws_only_through_endpoints"),
    ("every grant names the matcher", "security-groups.tf",
     "  referenced_security_group_id = aws_security_group.workload[each.value.client].id\n"
     "  ip_protocol                  = \"tcp\"\n  from_port                    = each.value.port",
     "  referenced_security_group_id = aws_security_group.workload[\"matcher\"].id\n"
     "  ip_protocol                  = \"tcp\"\n  from_port                    = each.value.port",
     "each_store_admits_only_its_clients"),
    ("every grant on the Aurora group", "security-groups.tf",
     "  security_group_id            = aws_security_group.store[each.value.store].id",
     '  security_group_id            = aws_security_group.store["aurora"].id',
     "each_store_admits_only_its_clients"),
    ("matcher may reach Valkey", "security-groups.tf",
     'clients = ["oms-api"] }', 'clients = ["oms-api", "matcher"] }',
     "each_store_admits_only_its_clients"),
    ("Aurora port 0", "security-groups.tf", "aurora = { port = 5432,", "aurora = { port = 0,",
     "each_store_admits_only_its_clients"),
    ("inline address-range ingress on a store", "security-groups.tf",
     'resource "aws_security_group" "store" {\n  for_each    = local.stores',
     'resource "aws_security_group" "store" {\n  for_each    = local.stores\n'
     '  ingress {\n    from_port   = 0\n    to_port     = 0\n    protocol    = "-1"\n    cidr_blocks = ["10.0.0.0/8"]\n  }',
     "each_store_admits_only_its_clients,checkov:CKV2_P1_4"),
    ("oms-api scrapes the brokers", "security-groups.tf",
     '  referenced_security_group_id = aws_security_group.workload["adot"].id\n  ip_protocol                  = "tcp"\n  from_port                    = 11001',
     '  referenced_security_group_id = aws_security_group.workload["oms-api"].id\n  ip_protocol                  = "tcp"\n  from_port                    = 11001',
     "each_store_admits_only_its_clients"),
    ("Aurora without forced TLS", "aurora.tf", 'value = "1"', 'value = "0"', "ledger_is_durable_and_private"),
    ("Aurora writer and reader in one zone", "aurora.tf",
     "availability_zone               = keys(local.zones)[count.index % length(var.zone_ids)]",
     "availability_zone               = keys(local.zones)[0]",
     "ledger_is_durable_and_private"),
    ("Aurora on the stream key", "aurora.tf",
     '  kms_key_id                          = aws_kms_key.data["ledger"].arn',
     '  kms_key_id                          = aws_kms_key.data["stream"].arn',
     "ledger_is_durable_and_private"),
    ("no pgaudit", "aurora.tf", 'value        = "pg_stat_statements,pgaudit"', 'value        = "pg_stat_statements"',
     "ledger_is_durable_and_private"),
    ("one in-sync replica", "msk.tf", "min.insync.replicas=${min(var.msk.brokers, 3) - 1}", "min.insync.replicas=1",
     "log_survives_a_broker"),
    ("unreplicated offsets", "msk.tf", "offsets.topic.replication.factor=${min(var.msk.brokers, 3)}",
     "offsets.topic.replication.factor=1", "log_survives_a_broker"),
    ("Kafka back to SCRAM", "msk.tf", "      iam = true", "      scram = true", "log_survives_a_broker"),
    ("MSK on the ledger key", "msk.tf", 'encryption_at_rest_kms_key_arn = aws_kms_key.data["stream"].arn',
     'encryption_at_rest_kms_key_arn = aws_kms_key.data["ledger"].arn', "log_survives_a_broker"),
    ("Valkey in one zone", "valkey.tf", "preferred_cache_cluster_azs = slice(keys(local.zones), 0, 2)",
     "preferred_cache_cluster_azs = [keys(local.zones)[0], keys(local.zones)[0]]", "limits_fail_over"),
    ("Valkey user on every key", "valkey.tf", 'access_string = "on ~rl:* -@all', 'access_string = "on ~* -@all',
     "limits_fail_over"),
    ("Valkey user may FLUSHALL", "valkey.tf", " -@dangerous +info", " +info", "limits_fail_over"),
    ("settler may write events", "iam.tf", 'oms-settler = { read = ["matcher.events"], write = []',
     'oms-settler = { read = ["matcher.events"], write = ["matcher.events"]', "each_service_gets_only_its_own_access"),
    ("marketdata holds a transactional id", "iam.tf",
     'groups = ["marketdata-*"], transactional_ids = []', 'groups = ["marketdata-*"], transactional_ids = ["matcher"]',
     "each_service_gets_only_its_own_access"),
    ("matcher may connect to Aurora", "iam.tf", 'oms-settler = "oms_settler" }',
     'oms-settler = "oms_settler", matcher = "oms_settler" }', "each_service_gets_only_its_own_access"),
    ("task roles assumable from any account", "iam.tf",
     '        StringEquals = { "aws:SourceAccount" = local.account }\n', "",
     "each_service_gets_only_its_own_access"),
    ("a service may create topics", "iam.tf",
     'Action   = ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData"]',
     'Action   = ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData", "kafka-cluster:CreateTopic"]',
     "each_service_gets_only_its_own_access"),
    ("default security group allows its members", "network.tf",
     'resource "aws_default_security_group" "closed" {\n  vpc_id = aws_vpc.main.id',
     'resource "aws_default_security_group" "closed" {\n  vpc_id = aws_vpc.main.id\n'
     '  ingress {\n    protocol  = -1\n    self      = true\n    from_port = 0\n    to_port   = 0\n  }',
     "network_and_keys_are_audited"),
    ("flow logs for rejects only", "network.tf", 'traffic_type             = "ALL"',
     'traffic_type             = "REJECT"', "network_and_keys_are_audited"),
    ("keys do not rotate", "kms.tf", "enable_key_rotation     = true", "enable_key_rotation     = false",
     "network_and_keys_are_audited"),
    ("anyone may delete a key", "kms.tf", '"kms:ScheduleKeyDeletion", ', "", "network_and_keys_are_audited"),
    ("MSK logs kept 30 days", "msk.tf", "retention_in_days = 365", "retention_in_days = 30",
     "network_and_keys_are_audited"),
    ("backup lock of 7 days", "backup.tf", "min_retention_days  = 35", "min_retention_days  = 7",
     "ledger_backups_cannot_be_deleted_early"),
]


def failed_runs(workdir):
    result = subprocess.run(["terraform", "test", "-no-color"], cwd=workdir, capture_output=True, text=True)
    return {line.split('"')[1] for line in result.stdout.splitlines() if line.strip().startswith("run ") and line.endswith("fail")}


def failed_checks(workdir):
    result = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{workdir}:/infra", CHECKOV, "--config-file", "/infra/.checkov.yaml",
         "-d", "/infra", "--external-checks-dir", "/infra/policies", "-o", "json", "--quiet"],
        capture_output=True, text=True)
    report = json.loads(result.stdout)
    report = report[0] if isinstance(report, list) else report
    return {check["check_id"] for check in report.get("results", {}).get("failed_checks", [])}


def main(selected):
    scratch = tempfile.mkdtemp(prefix="p1-breaks-")
    copy = os.path.join(scratch, "infra")
    shutil.copytree(STACK, copy, ignore=shutil.ignore_patterns(".terraform"))
    os.symlink(os.path.join(STACK, ".terraform"), os.path.join(copy, ".terraform"))
    missed = 0
    try:
        for name, file, old, new, expect in BREAKS:
            if selected and name not in selected:
                continue
            path = os.path.join(copy, file)
            original = open(path).read()
            if original.count(old) != 1:
                print(f"STALE   {name}: text not found once in {file}")
                missed += 1
                continue
            open(path, "w").write(original.replace(old, new))
            wanted = expect.split(",")
            got = failed_runs(copy) if any(not w.startswith("checkov:") for w in wanted) else set()
            if any(w.startswith("checkov:") for w in wanted):
                got |= {f"checkov:{check}" for check in failed_checks(copy)}
            open(path, "w").write(original)
            caught = all(w in got for w in wanted)
            missed += not caught
            print(f"{'caught ' if caught else 'MISSED '} {name} -> {expect}")
    finally:
        shutil.rmtree(scratch)
    print(f"{missed} missed")
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main(set(sys.argv[1:])))
