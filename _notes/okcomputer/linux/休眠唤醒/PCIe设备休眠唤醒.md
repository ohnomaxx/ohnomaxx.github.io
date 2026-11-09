---
layout: post
order: 2
title: "PCIe设备休眠唤醒"
date: 2026-11-08 00:00:00 +0800
categories: [okcomputer, linux, 休眠唤醒]
---

## 硬件能力

PCIe设备的休眠唤醒能力复用PCIe功耗管理的。

PCIe功耗管理分别定义了设备的功耗状态和链路的功耗状态：

设备功耗状态：
- D0：正常工作状态
- D1/D2：可选的中间状态
- D3hot：设备已经准备好断电，配置空间仍可访问
- D3cold：断电状态

链路功耗状态：
- L0：正常工作状态
- L0s：
- L1/L1.1/L1.2:
- L2：
- L3：断电状态

链路状态和设备功耗状态是互相关联的，状态关联表如下：


| Downstream Component D-state | Permissible Upstream Component D-state | Permissible Interconnect State |
|------------------------------|----------------------------------------|--------------------------------|
| D0                           | D0                                     | L0, L0s, L1, L2/L3 Ready       |
| D1                           | D0, D1                                 | L1, L2, L3 Ready               |
| D2                           | D0, D1, D2                             | L1, L2, L3 Ready               |
| D3Hot                        | D0, D1, D2, D3Hot                      | L1, L2, L3 Ready               |
| D3cold                       | D0, D1, D2, D3Hot, D3cold              | L2, L3                         |

1. 上游设备的休眠状态总是等于或浅于下游设备的休眠状态。
2. 上游设备和下游设备之间的链路进入比两侧设备更深的休眠状态。
3. 上游设备进入休眠状态后，链路不允许停留在活跃状态。
4. 下游设备进入D3cold后，链路仅允许进入L2/L3


### PCIe休眠

由软件控制的功耗状态转换是由PME消息实现的。PME消息本质是TLP报文。

PCIe需要休眠时，由根节点广播PME_Turn_Off报文到下游设备。

在任何D状态的设备都必须响应PME_Turn_Off，设备发回响应即表示设备本身已经准备好掉
电。

PME功能相关配置是由PCIe设备的PMCSR寄存器实现的：
// todo

PME_Turn_Off报文传输的限制：
1. 当一个function开始链路唤醒或PME事务，必须置位PME_status。
2. switch必须把来自下游的PME消息转发到上游。
3. 受到PME_Turn_Off消息，设备必须要返回PME_TO_Ack报文，并且在此之前不能传输其他
   的PME消息。
4. 上游设备进入低功耗状态前必须广播PME_Turn_Off报文。


### PCIe唤醒

// todo


## 软件实现

### prepare

调用设备的prepare函数。

### suspend

调用设备的suspend函数，完成设备的suspend.

如果设备没有实现pm回调，那么就通过配置PCI COMMAND register的bus master enable来
关闭设备，禁止设备新发起或处理总线事务。

除了允许唤醒系统的设备，禁止PCI设备新发出PME请求。

### suspend_late

调用设备的suspend_late函数，但在此之前会通过quirk来对设备执行一些操作，以兼容没
有按标准实现的设备。

### suspend_noirq

调用设备的suspend_noirq函数。

此后（按需）调用pci_prepare_to_sleep()函数，根据协议完成PCI状态的通用转换，
步骤如下：

1. 检查系统与此设备的唤醒配置。
   如果系统允许被唤醒，且这个设备也被允许唤醒系统，那么调用__pci_enable_wake()
   来为这个设备做出相应的配置。

2. 通过pci_set_power_state()来转换设备的功耗状态。
   先通过写入PMCSR寄存器来配置设备进入低功耗状态，再调用平台固件ACPI方法完成配置。
   配置PMCSR寄存器后，RP会自动向下游发出PME_Turn_Off报文，广播状态的转换。


### PME service

PME能力的使能是以pcie_port_service的形式提供的，drivers/pci/pcie/pme.c定义了这个
服务。


