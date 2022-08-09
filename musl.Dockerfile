FROM node:14-alpine

ENV PATH="/aarch64-linux-musl-cross/bin:/usr/local/cargo/bin/rustup:/root/.cargo/bin:$PATH" \
  CC="clang" \
  CXX="clang++" \
  GN_EXE=gn

RUN apk add --no-cache \
  musl-dev \
  wget \
  rustup \
  bash \
  python3 \
  git \
  build-base \
  clang \
  llvm \
  nasm \
  tar \
  xz \
  ninja && \
  apk add --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing gn && \
  ln -sf /usr/bin/python3 /usr/bin/python

RUN rustup-init -y && \
  wget https://github.com/napi-rs/napi-rs/releases/download/linux-musl-cross%4010/aarch64-linux-musl-cross.tgz && \
  tar -xvf aarch64-linux-musl-cross.tgz && \
  rm aarch64-linux-musl-cross.tgz
