"""Production tier: two regions, sharded matching, the same software and contracts."""
from diagrams import Cluster, Diagram, Edge
from diagrams.aws.analytics import ManagedStreamingForKafka as MSK
from diagrams.aws.compute import EC2Instances, ElasticKubernetesService as EKS
from diagrams.aws.database import Aurora, ElasticacheForRedis
from diagrams.aws.management import AmazonManagedGrafana, AmazonManagedPrometheus, Organizations
from diagrams.aws.network import CloudFront, GlobalAccelerator, NLB, Route53
from diagrams.aws.security import CloudHSM, Cognito, Shield, WAF
from diagrams.aws.storage import S3
from diagrams.onprem.client import Users

GRAPH = {"fontsize": "22", "fontname": "DejaVu Sans", "pad": "0.5", "nodesep": "0.6",
         "ranksep": "0.9", "splines": "spline", "labelloc": "t"}
NODE = {"fontsize": "13", "fontname": "DejaVu Sans"}
EDGE = {"fontsize": "11", "fontname": "DejaVu Sans"}


# A new Edge per connection: diagrams mutates an Edge when it is reused.
def flow(label="", **kw):
    return Edge(color="#2c3e50", label=label, **kw)


def replicate(label=""):
    return Edge(color="#d35400", style="bold", penwidth="2", label=label)


def ops(label="", **kw):
    return Edge(color="#7f8c8d", style="dashed", label=label, **kw)


def region(name, standby=False):
    """One region's stack. The standby runs the same stack, scaled down."""
    with Cluster(name):
        lb = NLB("NLB\nAPI + WebSocket")
        with Cluster("EKS: minimum size, warm images" if standby else "EKS: Karpenter, Graviton"):
            api = EKS("oms-api\nHPA on CPU, p99")
            gateway = EKS("WS gateways\nfan-out per symbol")
            workers = EKS("relay, settler\nper market shard")
        with Cluster("Matching shards"):
            matchers = EC2Instances("started on failover" if standby else "c7gn shards\nactive + hot standby")
        with Cluster("Data"):
            if standby:
                aurora = Aurora("Aurora Global\nsecondary, promotable")
                msk = MSK("MSK\nreplicated topics")
            else:
                aurora = Aurora("Aurora I/O-Optimized\nwriter + 2 readers\nRDS Proxy")
                msk = MSK("MSK, 6 brokers\ntiered storage")
            cache = ElasticacheForRedis("Valkey\ncluster mode")
        lb >> flow() >> [api, gateway]
        api >> flow() >> aurora
        api >> ops() >> cache
        workers >> flow() >> msk
        matchers >> flow("commands in,\nevents out", dir="both") >> msk
        gateway >> flow("events", dir="back") >> msk
        workers >> flow("ledger") >> aurora
    return lb, aurora, msk, cache, matchers


with Diagram("Exchange on AWS, production tier: two regions, sharded by market",
             filename="../img/aws-production", outformat=["png"], show=False, direction="TB",
             graph_attr=GRAPH, node_attr=NODE, edge_attr=EDGE):
    traders = Users("Traders,\nmarket makers")

    with Cluster("Global edge"):
        dns = Route53("Route 53\nhealth-checked failover")
        accel = GlobalAccelerator("Global Accelerator\nanycast API + WS")
        cdn = CloudFront("CloudFront\nweb app")
        guard = Shield("Shield Advanced")
        waf = WAF("WAF + Bot Control")

    with Cluster("Platform accounts (AWS Organizations)"):
        org = Organizations("Org, SCPs,\nControl Tower")
        idp = Cognito("Managed IdP\nMFA, passkeys")
        hsm = CloudHSM("CloudHSM\ncustody signing")
        obs = AmazonManagedPrometheus("Managed Prometheus\nSLO burn-rate alerts")
        grafana = AmazonManagedGrafana("Managed Grafana")

    primary_lb, primary_db, primary_msk, primary_cache, primary_matchers = region("ap-southeast-1: active, three AZs")
    dr_lb, dr_db, dr_msk, dr_cache, _ = region("ap-northeast-1: warm standby", standby=True)
    with Cluster("Backups"):
        archive = S3("S3: snapshots, ledger\nexports, cross-region")

    traders >> dns
    dns >> accel
    dns >> cdn
    guard >> ops(constraint="false") >> accel
    waf >> ops(constraint="false") >> cdn
    accel >> flow("active") >> primary_lb
    accel >> ops("on failover") >> dr_lb
    primary_db >> replicate("Aurora Global Database\n< 1 s lag") >> dr_db
    primary_msk >> replicate("MSK Replicator") >> dr_msk
    primary_cache >> ops("Global Datastore", constraint="false") >> dr_cache
    primary_matchers >> ops("book snapshots") >> archive
    obs >> ops(constraint="false") >> grafana
