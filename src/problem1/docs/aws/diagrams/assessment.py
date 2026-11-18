"""Assessment tier: one region, three zones, sized for 500 req/s at p99 < 100 ms."""
from diagrams import Cluster, Diagram, Edge
from diagrams.aws.analytics import ManagedStreamingForKafka as MSK
from diagrams.aws.compute import ECR, ElasticContainerServiceService as Svc
from diagrams.aws.database import Aurora, ElasticacheForRedis
from diagrams.aws.devtools import XRay
from diagrams.aws.management import AmazonManagedGrafana, AmazonManagedPrometheus, CloudwatchLogs
from diagrams.aws.network import ALB, CloudFront, Endpoint, NATGateway, Route53
from diagrams.aws.security import KMS, SecretsManager, Shield, WAF
from diagrams.aws.storage import S3
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.client import Users

GRAPH = {"fontsize": "22", "fontname": "DejaVu Sans", "pad": "0.5", "nodesep": "0.7",
         "ranksep": "0.9", "splines": "spline", "labelloc": "t"}
NODE = {"fontsize": "13", "fontname": "DejaVu Sans"}
EDGE = {"fontsize": "11", "fontname": "DejaVu Sans"}


# A new Edge per connection: diagrams mutates an Edge when it is reused.
def money(label="", **kw):
    return Edge(color="#c0392b", penwidth="2.5", label=label, **kw)


def events(label="", **kw):
    return Edge(color="#2471a3", penwidth="2", label=label, **kw)


def reads(label="", **kw):
    return Edge(color="#7d3c98", penwidth="1.5", label=label, **kw)


def ops(label="", **kw):
    return Edge(color="#7f8c8d", style="dashed", label=label, **kw)


with Diagram("Exchange on AWS, assessment tier: ap-southeast-1, three zones",
             filename="../img/aws-assessment", outformat=["png"], show=False, direction="TB",
             graph_attr=GRAPH, node_attr=NODE, edge_attr=EDGE):
    traders = Users("Traders\nweb, mobile, API")

    with Cluster("Global edge"):
        dns = Route53("Route 53")
        cdn = CloudFront("CloudFront\nTLS 1.2+, HTTP/2")
        waf = WAF("WAF\nrate-based + managed rules")
        shield = Shield("Shield Standard")
        web = S3("S3: web app")

    with Cluster("VPC 10.0.0.0/16, three AZs"):
        with Cluster("Public subnets"):
            nat = NATGateway("NAT gateway\nper AZ, egress")
            alb = ALB("ALB\npath routing")

        with Cluster("Private subnets: ECS on Fargate, tasks spread over three AZs"):
            api = Svc("oms-api\n3-12 x 1 vCPU")
            settler = Svc("oms-settler\n3 tasks")
            relay = Svc("oms-relay\n2 tasks, 1 leader")
            matcher = Svc("matcher\n1 per market group")
            md = Svc("marketdata\n3-9 x 0.5 vCPU\nREST + WebSocket")
            otel = Svc("ADOT collector\n2 tasks")

        with Cluster("Isolated data subnets: no route to the internet"):
            cache = ElasticacheForRedis("ElastiCache Valkey\nrate limits")
            aurora = Aurora("Aurora PostgreSQL\nwriter + reader")
            msk = MSK("MSK Kafka\n3 brokers, RF 3")

        vpce = Endpoint("VPC endpoints\nECR, S3, STS,\nSecrets, Logs, AMP")

    with Cluster("Regional services"):
        ecr = ECR("ECR\nimmutable tags")
        secrets = SecretsManager("Secrets Manager\nDB, JWT, custody keys")
        kms = KMS("KMS")
        snapshots = S3("S3\nbook snapshots")

    with Cluster("Observability: managed LGTM"):
        amp = AmazonManagedPrometheus("Managed Prometheus")
        xray = XRay("X-Ray traces")
        logs = CloudwatchLogs("CloudWatch Logs")
        grafana = AmazonManagedGrafana("Managed Grafana\nwave 1 dashboards")

    ci = GithubActions("GitHub Actions\nOIDC, no stored keys")

    # Request path.
    traders >> dns >> cdn
    waf >> ops(constraint="false") >> cdn
    shield >> ops(constraint="false") >> cdn
    cdn >> ops("static", constraint="false") >> web
    cdn >> Edge(label="/v1/*, /ws") >> alb
    alb >> money("orders") >> api
    alb >> reads("market data") >> md

    # Money path: one transaction per order, then the async pipeline.
    api >> money("order + outbox\none transaction") >> aurora
    api >> ops("limits") >> cache
    relay >> money("read outbox", dir="back") >> aurora
    relay >> events("commands") >> msk
    matcher >> events("consume commands,\npublish events", dir="both") >> msk
    settler >> events("consume events", dir="back") >> msk
    settler >> money("ledger", constraint="false") >> aurora
    md >> reads("consume events", dir="back") >> msk

    # Operations.
    matcher >> ops("snapshots", constraint="false") >> snapshots
    api >> ops("OTLP from every task", constraint="false") >> otel
    otel >> ops() >> amp
    otel >> ops() >> xray
    otel >> ops() >> logs
    amp >> ops() >> grafana
    ci >> ops("push image") >> ecr
    secrets >> ops(constraint="false") >> kms
