#!/bin/sh
# O disco do Fly.io chega com dono "root". Ajusta a permissão e depois roda o
# sistema como o usuário "node" (sem privilégios de administrador), por segurança.
set -e
mkdir -p "${PASTA_DADOS:-/data}"
chown -R node:node "${PASTA_DADOS:-/data}"
exec setpriv --reuid=node --regid=node --init-groups "$@"
