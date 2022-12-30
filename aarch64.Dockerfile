FROM ghcr.io/napi-rs/napi-rs/nodejs-rust:lts-debian-aarch64

ENV CFLAGS="-fuse-ld=lld --sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot" \
  CXXFLAGS="-fuse-ld=lld --sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot -stdlib=libc++"

ADD ./lib/llvm-15 /usr/aarch64-unknown-linux-gnu/lib/llvm-15

RUN apt-get update && \
  apt-get install libssl-dev libc++-15-dev libc++abi-15-dev pkg-config -y --fix-missing --no-install-recommends && \
  cp -r /usr/aarch64-unknown-linux-gnu/lib/gcc /usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib/ && \
  rm -rf /var/lib/apt/lists/*
