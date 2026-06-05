locals {
  helm_keyspaces = [
    {
      name = "temporal"
      externalShards = [
        {
          keyRange = {}
          host     = tencentcloud_mysql_instance.tablet["temporal"].intranet_ip
          port     = 3306
          database = local.mysql_tablets["temporal"].database
        }
      ]
    },
    {
      name = "temporal_sharded"
      externalShards = [
        {
          keyRange = local.mysql_tablets["temporal_sharded_left"].shard
          host     = tencentcloud_mysql_instance.tablet["temporal_sharded_left"].intranet_ip
          port     = 3306
          database = local.mysql_tablets["temporal_sharded_left"].database
        },
        {
          keyRange = local.mysql_tablets["temporal_sharded_right"].shard
          host     = tencentcloud_mysql_instance.tablet["temporal_sharded_right"].intranet_ip
          port     = 3306
          database = local.mysql_tablets["temporal_sharded_right"].database
        }
      ]
    },
    {
      name = "temporal_visibility"
      externalShards = [
        {
          keyRange = {}
          host     = tencentcloud_mysql_instance.tablet["temporal_visibility"].intranet_ip
          port     = 3306
          database = local.mysql_tablets["temporal_visibility"].database
        }
      ]
    }
  ]

  temporal_vitess_helm_values = {
    vitess = {
      cluster = {
        globalLockserver = {
          enabled        = true
          implementation = "etcd2"
          address        = var.managed_etcd_address
          rootPath       = var.managed_etcd_root_path
        }
        externalDatastore = {
          user = var.mysql_vitess_user
          credentialsSecret = {
            create = false
            name   = "temporal-vitess-external-mysql"
            key    = "credentials.json"
          }
        }
        keyspaces = local.helm_keyspaces
      }
    }
  }
}

output "tke_cluster_id" {
  description = "Managed TKE cluster id."
  value       = tencentcloud_kubernetes_cluster.this.id
}

output "tke_cluster_external_endpoint" {
  description = "Managed TKE internet API endpoint when api_server_allowed_cidrs is non-empty."
  value       = try(tencentcloud_kubernetes_cluster_endpoint.internet[0].cluster_external_endpoint, null)
}

output "vpc_id" {
  description = "VPC id."
  value       = tencentcloud_vpc.this.id
}

output "subnet_ids" {
  description = "Subnet ids by logical name."
  value       = { for name, subnet in tencentcloud_subnet.this : name => subnet.id }
}

output "mysql_tablets" {
  description = "TencentDB for MySQL tablet mapping for Vitess externalDatastore."
  value = {
    for name, tablet in local.mysql_tablets : name => {
      instance_id = tencentcloud_mysql_instance.tablet[name].id
      keyspace    = tablet.keyspace
      database    = tablet.database
      host        = tencentcloud_mysql_instance.tablet[name].intranet_ip
      port        = 3306
      shard       = tablet.shard
    }
  }
}

output "vitess_external_datastore_secret_json" {
  description = "Secret data for temporal-vitess-external-mysql/credentials.json. Store this in Kubernetes Secret/SOPS/SSM; do not commit it."
  value       = jsonencode({ (var.mysql_vitess_user) = [var.mysql_vitess_password] })
  sensitive   = true
}

output "temporal_vitess_helm_values_yaml" {
  description = "Helm values overlay that connects the chart to TencentDB for MySQL and managed etcd."
  value       = yamlencode(local.temporal_vitess_helm_values)
}
