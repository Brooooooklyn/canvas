FROM ghcr.io/napi-rs/napi-rs/nodejs-rust:lts-debian-aarch64

ADD ./lib/llvm-14 /usr/aarch64-unknown-linux-gnu/lib/llvm-14

RUN apt-get update && \
  apt-get install libssl-dev libc++-14-dev libc++abi-14-dev pkg-config -y --fix-missing --no-install-recommends && \
  cp -r /usr/aarch64-unknown-linux-gnu/lib/gcc /usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib/ && \
  rm -rf /var/lib/apt/lists/*
