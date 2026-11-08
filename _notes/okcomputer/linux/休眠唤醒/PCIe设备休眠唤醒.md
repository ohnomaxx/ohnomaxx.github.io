---
layout: post
order: 2
title: "PCIe设备休眠唤醒"
date: 2026-11-08 00:00:00 +0800
categories: [okcomputer, linux, 休眠唤醒]
---

PCIe的休眠唤醒相关回调在struct pci_bus_type中定义，作为pci总线的休眠唤醒实现，
根据pm子系统的机制，调用pci设备的休眠唤醒时，会先调用bus的休眠函数。

Linux中定义了软件侧的PCIe设备休眠唤醒状态，分为以下几类：
- RPM_INVALID
- RPM_ACTIVE
- RPM_RESUMING
- RPM_SUSPENDED
- RPM_SUSPENDING
- RPM_BLOCKED

以上定义中的RPM是runtime power management的缩写。

PCIe设备还区分是否支持RPM，：


prepare
-------

