FROM node:14-alpine

ENV PATH="/aarch64-linux-musl-cross/bin:/usr/local/cargo/bin/rustup:/root/.cargo/bin:$PATH" \
  CC="clang" \
  CXX="clang++" \
  GN_EXE=gn

RUN apk add --update --no-cache musl-dev wget rustup \
  bash \
  python3 \
  python2 \
  git \
  build-base \
  clang \
  nasm \
  llvm \
  nasm \
  tar \
  xz \
  ninja && \
  apk add --update --no-cache --repository http://dl-cdn.alpinelinux.org/alpine/edge/testing gn

RUN rustup-init -y && \
  yarn global add pnpm && \
  wget http://more.musl.cc/10/x86_64-linux-musl/aarch64-linux-musl-cross.tgz && \
  tar -xvf aarch64-linux-musl-cross.tgz && \
  rm aarch64-linux-musl-cross.tgz
