environment  = "production"
vpc_cidr     = "10.20.0.0/16"
zone_count   = 3
nat_per_zone = true
aurora       = { instance_class = "db.r7g.large", instances = 2, engine_version = "17.11" }
msk          = { instance_type = "kafka.m7g.large", brokers = 3, volume_gb = 100, kafka_version = "4.1.x.kraft" }
valkey       = { node_type = "cache.t4g.small", engine_version = "8.2" }
