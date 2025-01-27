FROM node:18-alpine

ENV PATH="/aarch64-linux-musl-cross/bin:/usr/local/cargo/bin/rustup:/root/.cargo/bin:$PATH" \
  GN_EXE=gn

COPY aom /usr/aarch64-alpine-linux-musl/aom

RUN apk add --no-cache \
  musl-dev \
  wget \
  rustup \
  bash \
  python3 \
  git \
  build-base \
  cmake \
  perl \
  clang \
  llvm \
  libc++-dev \
  tar \
  xz \
  ninja && \
  apk add --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing gn perl nasm aom-dev meson && \
  ln -sf /usr/bin/python3 /usr/bin/python

RUN rustup-init -y && \
  wget https://github.com/napi-rs/napi-rs/releases/download/linux-musl-cross%4010/aarch64-linux-musl-cross.tgz && \
  tar -xvf aarch64-linux-musl-cross.tgz && \
  rm aarch64-linux-musl-cross.tgz
