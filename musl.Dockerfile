FROM node:22-alpine

ENV PATH="/aarch64-linux-musl-cross/bin:/usr/local/cargo/bin/rustup:/root/.cargo/bin:$PATH" \
  GN_EXE=gn

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
  libc++-static \
  llvm-libunwind-static \
  tar \
  xz \
  ninja && \
  gn && \
  apk add --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing gn perl nasm aom-dev meson && \
  ln -sf /usr/bin/python3 /usr/bin/python

RUN rustup-init -y && \
  wget https://github.com/napi-rs/napi-rs/releases/download/linux-musl-cross%4010/aarch64-linux-musl-cross.tgz && \
  tar -xvf aarch64-linux-musl-cross.tgz && \
  rm aarch64-linux-musl-cross.tgz
