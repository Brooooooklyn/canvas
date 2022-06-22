FROM messense/manylinux2014-cross:x86_64

ARG NASM_VERSION=2.15.05

ENV RUSTUP_HOME=/usr/local/rustup \
  CARGO_HOME=/usr/local/cargo \
  PATH=/usr/local/cargo/bin:$PATH \
  CC=clang \
  CXX=clang++ \
  CC_x86_64_unknown_linux_gnu=clang \
  CXX_x86_64_unknown_linux_gnu=clang++ \
  RUST_TARGET=x86_64-unknown-linux-gnu

RUN apt-get update && \
  apt-get install -y --fix-missing --no-install-recommends gpg-agent ca-certificates openssl && \
  wget -O - https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add - && \
  echo "deb http://apt.llvm.org/focal/ llvm-toolchain-focal-14 main" >> /etc/apt/sources.list && \
  echo "deb-src http://apt.llvm.org/focal/ llvm-toolchain-focal-14 main" >> /etc/apt/sources.list && \
  curl -sL https://deb.nodesource.com/setup_16.x | bash - && \
  apt-get update && \
  apt-get install -y --fix-missing --no-install-recommends \
  curl \
  llvm-14 \
  clang-14 \
  lld-14 \
  libc++-14-dev \
  nodejs \
  rcs \
  xz-utils \
  rcs \
  git \
  make \
  ninja-build && \
  ln -sf /usr/bin/clang-14 /usr/bin/clang && \
  ln -sf /usr/bin/clang++-14 /usr/bin/clang++ && \
  ln -sf /usr/bin/lld-14 /usr/bin/lld && \
  ln -sf /usr/bin/clang-14 /usr/bin/cc && \
  ln -sf /usr/lib/llvm-14/lib/libc++abi.so.1.0 /usr/lib/llvm-14/lib/libc++abi.so && \
  npm install --location=global yarn && \
  npm cache clean --force && \
  curl https://sh.rustup.rs -sSf | sh -s -- -y && \
  rm -rf /var/lib/apt/lists/*

RUN wget https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz && \
  tar -xf nasm-${NASM_VERSION}.tar.xz && \
  cd nasm-${NASM_VERSION} && \
  ./configure --prefix=/usr/ && \
  make && \
  make install && \
  cd / && \
  rm -rf nasm-${NASM_VERSION} && \
  rm nasm-${NASM_VERSION}.tar.xz
