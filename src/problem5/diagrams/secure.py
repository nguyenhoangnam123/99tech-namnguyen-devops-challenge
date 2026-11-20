"""Problem 1's assessment tier after the Problem 5 review, changes marked."""
from diagrams import Cluster, Diagram, Edge
from diagrams.aws.analytics import ManagedStreamingForKafka as MSK
from diagrams.aws.compute import ElasticContainerServiceService as Svc
from diagrams.aws.database import Aurora, ElasticacheForRedis
from diagrams.aws.management import Cloudtrail, Organizations
from diagrams.aws.network import ALB, CloudFront, Endpoint
from diagrams.aws.security import (Cognito, Guardduty, IAMRole, KMS, SecurityHub, Shield,
                                   SingleSignOn, WAF)
from diagrams.aws.storage import Backup
from diagrams.generic.storage import Storage
from diagrams.onprem.client import Users

GRAPH = {"fontsize": "22", "fontname": "DejaVu Sans", "pad": "0.5", "nodesep": "0.6",
         "ranksep": "0.9", "splines": "spline", "labelloc": "t"}
NODE = {"fontsize": "13", "fontname": "DejaVu Sans"}
EDGE = {"fontsize": "11", "fontname": "DejaVu Sans"}
# Fill marks what the review did: green added, amber changed.
ADDED = {"bgcolor": "#e9f7ef", "pencolor": "#1e8449", "penwidth": "2"}
CHANGED = {"bgcolor": "#fef5e7", "pencolor": "#b9770e", "penwidth": "2"}
ACCOUNT = {"bgcolor": "#ffffff", "pencolor": "#5d6d7e", "penwidth": "2", "style": "dashed"}


def money(label="", **kw):
    return Edge(color="#c0392b", penwidth="2.5", label=label, **kw)


def events(label="", **kw):
    return Edge(color="#2471a3", penwidth="2", label=label, **kw)


def control(label="", **kw):
    return Edge(color="#1e8449", style="dashed", label=label, **kw)


with Diagram("Exchange on AWS after the security review: green added, amber changed",
             filename="../img/aws-secure", outformat=["png"], show=False, direction="TB",
             graph_attr=GRAPH, node_attr=NODE, edge_attr=EDGE):
    traders = Users("Traders\nweb, mobile, API keys")

    with Cluster("Edge (changed)", graph_attr=CHANGED):
        cdn = CloudFront("CloudFront\nTLS 1.2+")
        waf = WAF("WAF\n+ Bot Control, ATP\non login")
        shield = Shield("Shield Advanced\nat public launch")
        idp = Cognito("Cognito\npasskeys + MFA\n(replaces wave 1 login)")

    with Cluster("Production account", graph_attr=ACCOUNT):
        with Cluster("Public subnets"):
            alb = ALB("ALB\nCloudFront only")

        with Cluster("Private subnets: no route to the internet (changed)", graph_attr=CHANGED):
            api = Svc("oms-api\nsigned API requests")
            relay = Svc("oms-relay")
            settler = Svc("oms-settler")
            matcher = Svc("matcher")
            md = Svc("marketdata")
            roles = IAMRole("Task role per service\n(added)")

        with Cluster("Isolated subnets: per-service access (changed)", graph_attr=CHANGED):
            cache = ElasticacheForRedis("Valkey\nIAM user,\nrl:* keys only")
            aurora = Aurora("Aurora\nIAM auth,\nrole per service,\npgaudit")
            msk = MSK("MSK\nIAM per topic\nand group")

        with Cluster("Added in this account", graph_attr=ADDED):
            vpce = Endpoint("Interface endpoints\nthe only way out")
            kms = KMS("KMS key per\ndata class")
            backup = Backup("AWS Backup\nlocked vault, 35 days")
            recon = Svc("reconciler\nledger vs chain,\nkill switches")

    with Cluster("Custody account (added)", graph_attr=ADDED):
        withdraw = Svc("withdrawal service\nlimits, allowlist delay,\nsecond approver")
        hsm = KMS("KMS signing keys\nsecp256k1, hot wallet,\nnon-exportable")
        cold = Storage("Cold storage\noffline, most funds\n(outside AWS)")

    with Cluster("Security and log archive accounts (added)", graph_attr=ADDED):
        org = Organizations("Organizations\nSCPs")
        sso = SingleSignOn("Identity Center\nstaff SSO + MFA")
        trail = Cloudtrail("Org CloudTrail\nObject Lock bucket")
        gd = Guardduty("GuardDuty")
        hub = SecurityHub("Security Hub")

    traders >> cdn
    traders >> Edge(label="sign in") >> idp
    cdn >> Edge(label="/v1/*, /ws") >> alb
    alb >> money("orders") >> api
    alb >> events("market data") >> md

    api >> money("order + hold") >> aurora
    api >> control("limits") >> cache
    relay >> events("commands") >> msk
    msk >> events("commands") >> matcher
    matcher >> events("events") >> msk
    msk >> events("events") >> settler
    settler >> money("ledger") >> aurora
    msk >> events() >> md

    api >> money("withdrawal request\nafter step-up") >> withdraw
    withdraw >> money("sign") >> hsm
    hsm >> control("sweep and top-up,\nmanual ceremony", dir="both") >> cold
