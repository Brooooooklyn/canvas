FROM messense/manylinux2014-cross:x86_64

ARG NASM_VERSION=2.16.01

ENV RUSTUP_HOME=/usr/local/rustup \
  CARGO_HOME=/usr/local/cargo \
  PATH=/usr/local/cargo/bin:$PATH \
  CC=clang \
  CXX=clang++ \
  CC_x86_64_unknown_linux_gnu=clang \
  CXX_x86_64_unknown_linux_gnu=clang++ \
  RUST_TARGET=x86_64-unknown-linux-gnu \
  LDFLAGS="-fuse-ld=lld --sysroot=/usr/x86_64-unknown-linux-gnu/x86_64-unknown-linux-gnu/sysroot -L/usr/lib/llvm-16/lib" \
  CFLAGS="-fuse-ld=lld --sysroot=/usr/x86_64-unknown-linux-gnu/x86_64-unknown-linux-gnu/sysroot" \
  CXXFLAGS="-fuse-ld=lld -stdlib=libc++ --sysroot=/usr/x86_64-unknown-linux-gnu/x86_64-unknown-linux-gnu/sysroot"

RUN apt-get update && \
  apt-get install -y --fix-missing --no-install-recommends gpg-agent ca-certificates openssl && \
  wget -O - https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add - && \
  echo "deb http://apt.llvm.org/jammy/ llvm-toolchain-jammy-16 main" >> /etc/apt/sources.list && \
  echo "deb-src http://apt.llvm.org/jammy/ llvm-toolchain-jammy-16 main" >> /etc/apt/sources.list && \
  curl -sL https://deb.nodesource.com/setup_18.x | bash - && \
  apt-get update && \
  apt-get install -y --fix-missing --no-install-recommends \
  curl \
  llvm-16 \
  clang-16 \
  lld-16 \
  libc++-16-dev \
  libc++abi-16-dev \
  nodejs \
  rcs \
  xz-utils \
  rcs \
  git \
  make \
  ninja-build && \
  ln -sf /usr/bin/clang-16 /usr/bin/clang && \
  ln -sf /usr/bin/clang++-16 /usr/bin/clang++ && \
  ln -sf /usr/bin/lld-16 /usr/bin/lld && \
  rm /usr/lib/llvm-16/lib/libc++abi.so && \
  rm /usr/lib/llvm-16/lib/libunwind.so && \
  ln -sf /usr/lib/llvm-16/lib/libc++.a /usr/x86_64-unknown-linux-gnu/lib/gcc/x86_64-unknown-linux-gnu/4.8.5/libc++.a && \
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
