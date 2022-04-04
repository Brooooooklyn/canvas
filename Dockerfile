FROM node:16-buster

ARG NASM_VERSION=2.15.05

ENV RUSTUP_HOME=/usr/local/rustup \
  CARGO_HOME=/usr/local/cargo \
  PATH=/usr/local/cargo/bin:$PATH

RUN wget -O - https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add - && \
  echo "deb http://apt.llvm.org/buster/ llvm-toolchain-buster-13 main" >> /etc/apt/sources.list && \
  echo "deb-src http://apt.llvm.org/buster/ llvm-toolchain-buster-13 main" >> /etc/apt/sources.list && \
  apt-get update && \
  apt-get install -y --fix-missing \
  llvm-13 \
  clang-13 \
  lld-13 \
  rcs \
  ninja-build && \
  ln -sf /usr/bin/clang-13 /usr/bin/clang && \
  ln -sf /usr/bin/clang++-13 /usr/bin/clang++ && \
  ln -sf /usr/bin/lld-13 /usr/bin/lld && \
  ln -sf /usr/bin/clang-13 /usr/bin/cc && \
  curl https://sh.rustup.rs -sSf | sh -s -- -y

RUN wget https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz && \
  tar -xf nasm-${NASM_VERSION}.tar.xz && \
  cd nasm-${NASM_VERSION} && \
  ./configure --prefix=/usr/ && \
  make && \
  make install && \
  cd / && \
  rm -rf nasm-${NASM_VERSION} && \
  rm nasm-${NASM_VERSION}.tar.xz
