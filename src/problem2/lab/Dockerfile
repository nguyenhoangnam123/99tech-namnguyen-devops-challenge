# Ubuntu 24.04 with the distribution's NGINX and logrotate, as on the VM.
FROM ubuntu:24.04@sha256:ab18ecc70c55c703eae968948f9f1dbbe662aa8d9badac7c982e6a6237b9d74c
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx logrotate curl lvm2 \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default \
 && head -c 1048576 /dev/urandom > /srv/blob.bin \
 && head -c 65536 /dev/urandom > /srv/post.bin \
 && printf '%s\n' 'devices { obtain_device_list_from_udev = 0 }' \
      'activation { udev_sync = 0 udev_rules = 0 }' >> /etc/lvm/lvm.conf
# A container has no udev, so LVM creates its own device nodes.
ENV DM_DISABLE_UDEV=1
COPY conf/ /lab/conf/
COPY scenario.sh /lab/scenario.sh
ENTRYPOINT ["/lab/scenario.sh", "start"]
