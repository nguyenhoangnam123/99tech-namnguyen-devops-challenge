# Renders the AWS diagrams; no Python or Graphviz needed on the host.
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends graphviz fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* && pip install --no-cache-dir diagrams==0.25.1
WORKDIR /work
