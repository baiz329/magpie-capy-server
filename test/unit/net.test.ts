import { expect, test } from "bun:test";

import {
  isBlockedHostname,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  isIpLiteral,
  parseIpv4,
  parseIpv6,
} from "../../src/domain/net.ts";

test("net：回环/私网/链路本地/CGNAT/保留段/组播一律禁", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ]) {
    expect(isBlockedIp(ip)).toBe(true);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) {
    expect(isBlockedIp(ip)).toBe(false);
  }
});

test("net：前导零按不可解析处理（禁段兜底）", () => {
  expect(parseIpv4("010.0.0.1")).toBeNull();
  expect(isBlockedIp("010.0.0.1")).toBe(true);
  expect(parseIpv4("256.0.0.1")).toBeNull();
  expect(parseIpv4("1.2.3")).toBeNull();
});

test("net：IPv6 ULA/链路本地/组播/文档段禁，::ffff: 映射按内嵌 IPv4 判", () => {
  expect(isBlockedIp("::1")).toBe(true);
  expect(isBlockedIp("fe80::1")).toBe(true);
  expect(isBlockedIp("fc00::1")).toBe(true);
  expect(isBlockedIp("fd12:3456::1")).toBe(true);
  expect(isBlockedIp("ff02::1")).toBe(true);
  expect(isBlockedIp("2001:db8::1")).toBe(true);
  expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
  expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  expect(isBlockedIp("::")).toBe(true);
});

test("net：parseIpv6 支持压缩与内嵌 IPv4", () => {
  const mapped = parseIpv6("::ffff:1.2.3.4");
  expect(mapped?.isV4Mapped).toBe(true);
  expect(mapped?.v4).toEqual([1, 2, 3, 4]);
  expect(parseIpv6("2001:db8::1")?.groups.length).toBe(8);
  expect(parseIpv6("not-an-ip")).toBeNull();
  expect(parseIpv6("1.2.3.4")).toBeNull();
  expect(isBlockedIpv4([127, 0, 0, 1])).toBe(true);
  expect(isBlockedIpv6(parseIpv6("2001:4860:4860::8888")!)).toBe(false);
});

test("net：主机名防呆——localhost/.local/.internal 与私网字面量禁，普通域名放行", () => {
  expect(isBlockedHostname("localhost")).toBe(true);
  expect(isBlockedHostname("foo.local")).toBe(true);
  expect(isBlockedHostname("foo.internal")).toBe(true);
  expect(isBlockedHostname("127.0.0.1")).toBe(true);
  expect(isBlockedHostname("10.0.0.5")).toBe(true);
  expect(isBlockedHostname("example.com")).toBe(false);
  expect(isBlockedHostname("capy.ai")).toBe(false);
  expect(isBlockedHostname("")).toBe(true);
  expect(isIpLiteral("8.8.8.8")).toBe(true);
  expect(isIpLiteral("::1")).toBe(true);
  expect(isIpLiteral("example.com")).toBe(false);
});
