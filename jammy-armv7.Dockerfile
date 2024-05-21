FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
  libc++-18-dev \
  libc++abi-18-dev
