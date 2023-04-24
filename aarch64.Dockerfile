FROM ghcr.io/napi-rs/napi-rs/nodejs-rust:lts-debian-aarch64

ENV CFLAGS="-fuse-ld=lld --sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot" \
  CXXFLAGS="-fuse-ld=lld --sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot -L/usr/aarch64-unknown-linux-gnu/lib/llvm-16/lib -stdlib=libc++"

ADD ./lib/llvm-16 /usr/aarch64-unknown-linux-gnu/lib/llvm-16

RUN echo "deb http://apt.llvm.org/jammy/ llvm-toolchain-jammy-16 main" >> /etc/apt/sources.list && \
  echo "deb-src http://apt.llvm.org/jammy/ llvm-toolchain-jammy-16 main" >> /etc/apt/sources.list && \
  apt-get update && \
  apt-get install libssl-dev llvm-16 clang-16 lld-16 libc++-16-dev libc++abi-16-dev pkg-config -y --fix-missing --no-install-recommends && \
  cp -r /usr/aarch64-unknown-linux-gnu/lib/gcc /usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib/ && \
  rm -rf /var/lib/apt/lists/*
