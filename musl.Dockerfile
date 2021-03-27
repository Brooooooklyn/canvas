FROM node:lts-alpine

ENV PATH="/usr/local/cargo/bin/rustup:/root/.cargo/bin:$PATH" \
  CC="clang" \
  CXX="clang++" \
  GN_EXE=gn

RUN sed -i -e 's/v[[:digit:]]\..*\//edge\//g' /etc/apk/repositories && \
  apk add --update --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing \
  rustup \
  bash \
  python3 \
  python2 \
  git \
  musl-dev \
  build-base \
  clang \
  llvm \
  gn \
  ninja && \
  rustup-init -y
