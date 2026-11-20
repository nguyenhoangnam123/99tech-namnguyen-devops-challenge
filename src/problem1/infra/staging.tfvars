# MSK needs at least two brokers in two zones, so staging keeps two zones.
environment = "staging"
vpc_cidr    = "10.21.0.0/16"
zone_count  = 2
aurora      = { instance_class = "db.t4g.medium", instances = 1, engine_version = "17.11" }
msk         = { instance_type = "kafka.t3.small", brokers = 2, volume_gb = 20, kafka_version = "4.1.x.kraft" }
valkey      = { node_type = "cache.t4g.micro", engine_version = "8.2" }
