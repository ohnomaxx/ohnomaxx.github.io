---
layout: post
order: 1
title: "sched_ext"
date: 2026-11-18
categories: [okcomputer, linux]
last_modified_at: 2026-11-18
---

## 背景

### Linux原生调度器

调度器操作的对象是进程，就是挑选一个CPU执行给定的任务。
基于这个目的，调度器需要协调的是任务和CPU资源，也就是需要回答下面两个问题：

1. 一个CPU有多个任务需要执行时，应该如何选择下一个需要执行的任务？

	Linux存在多种调度算法，不同的调度算法通过调度类（sched_class）来承载，目前
	Linux支持以下调度类，不同的调度类支持不同的调度算法。

	- stop：仅在内核内部使用，用于migration threads或CPU热插拔
	- dl：周期性的，需要及时完成的任务
	- rt：延迟敏感的任务
	- fair：几乎所有任务，进程默认进入fair调度类
	- ext：使用BPF注入的调度器
	- idle：优先级最低，CPU在无事可做的时候执行，例如swapper进程

	经典的调度算法包括CFS、RR、FIFO、EEVDF等，不同的调度算法需要自己的数据结构
	维护待执行的任务的状态，通过回调的方式实现sched_core的操作。

	Linux通过任务的policy来选择任务的调度器，policy在clone/fork时从父进程拷贝，
	也可以通过syscall来指定，部分内核线程有固定的policy。

2. 有多个CPU可供选择时，选择哪个CPU来执行任务？

	Linux为每个CPU维护了待执行任务的列表，也就是struct rq。

	每个调度类提供了选择CPU的回调，允许调度类自己实现寻找执行任务的CPU的算法。
	调度类根据自定义的算法，找到可以执行给定任务的CPU后，把这个任务添加到这个CPU
	的runqueue中，就完成了选择CPU的任务。后续每个CPU根据调度类的算法，从自己的
	runqueue中挑选优先级最高的任务执行。

在挑选CPU时，还需要回答两个问题：

1. CPU之间可能是异构的，比如核与核之间的算力不同，或者核与存储器的距离（亲和性）
   不同，此时如何正确地挑选到合适的CPU执行任务？

   Linux根据硬件的拓扑，使用调度域来描述不同CPU之间的关系。在选择CPU执行任务的
   时候，尽量在临近的调度域内选择CPU来执行任务，尽量保证调度前后的cache hotness。

2. 假如调度器把所有任务都分配到一个CPU，空闲CPU会出现浪费，又可能导致部分任务
   无法及时得到调度。如何平衡不同CPU之间的负载？

   Linux实现了负载均衡，能够在不同等级的调度域之间实现负载均衡。

因此，总结调度器的原理，就是根据任务policy选择调度器，由调度器为任务指定CPU，把
这个任务添加到这个CPU的runqueue，并通过调度算法在这个CPU上选择下一个需要执行的
任务，同时通过负载均衡保证不同调度域之间的CPU负载均衡。


### cgroup

cgroup是Linux的一种资源管理机制，可以以组为单位管理任务。支持管理的资源包括CPU
范围与时间份额、内存使用量、IO带宽等。

对调度器来讲，一个cgroup通过一个sched_entity来参与调度，一个普通任务自己就是一个
sched_entity。调度器先根据调度算法选择一个sched_entity，如果这个sched_entity中
包含多个子sched_entity，那么就在子sched_entity中根据调度算法重新选择本层级的
entity，直到选择到一个任务来执行。

```txt
struct sched_entity {
    struct sched_entity *parent;	// 当前实体的父级组实体
    struct cfs_rq *cfs_rq;			// 当前实体参与调度竞争的实体
    struct cfs_rq *my_q;			// 当前实体代表一个组时，对应的子级队列
};

CPU 0 / struct rq
    |
    +-- Root cfs_rq
    |     |
    |     +-- RB Tree 0
    |           |
    |           +-- Task A se
    |           |
    |           +-- Group X se
    |                 |
    |                 +-- my_q --> Group X cfs_rq
    |                                  |
    |                                  +-- RB Tree 1
    |                                        |
    |                                        +-- Task B se
    |                                        |
    |                                        +-- Group Y se
    |                                              |
    |                                              +-- my_q --> Group Y cfs_rq
    |                                                               |
    |                                                               +-- RB Tree 2
    |                                                                     |
    |                                                                     +-- Task C se
    |                                                                     +-- Task D se
```

### eBPF

eBPF（extended Berkeley Packet Fliter）前身是用来过滤网络报文的机制，经过发展
演变为内核的一种可编程机制，允许开发者在不修改内核源码、不加载传统内核模块的情况
下，将经过验证的程序动态加载到内核中执行。

目前eBPF在内核中的主要使用场景是性能分析、tracing、网络流量过滤与转发以及
sched_ext。

eBPF可以认为是一种语言，支持在前端通过C、rust等编译为BPF字节码程序，再通过Linux
中实现的JIT动态加载并转译为原生的Arm64/x86汇编指令来执行。

sched_ext就是利用了BPF的能力，把用户态编写的调度相关的代码，转译为BPF程序，通过
BPF的能力动态加载执行。

## sched_ext

sched_ext调度器作为一种调度类接入内核，默认的优先级低于fair调度类，但加载以后
默认会把所有fair调度器负责的任务交给sched_ext调度器执行。

sched_ext调度器类可以认为是内核调度器子系统与BPF可编程调度器的转换层。

### DSQ

Linux的原生调度器使用per-cpu的runqueue来管理每个CPU需要执行的任务。为了支持不同
的调度器，struct rq中为不同的调度器分别定义了列表：

```c
struct rq {
	// ...
	struct cfs_rq cfs;
	struct rt_rq rt;
	struct dl_rq dl;
	struct scx_rq scx;
	// ...
};
```

为了实现面向用户态的可编程调度器与内核的其他调度器隔离，struct scx_rq使用DSQ
（dispatch queue）来管理任务。

```c
struct scx_rq {
	struct scx_dispatch_q local_dsq;
	struct scx_dispatch_q reject_dsq;
#ifdef CONFIG_EXT_SUB_SCHED
	struct scx_rq_rescue rescue;
#endif
	struct list_head runnable_list;
	u32 nr_running;
	struct scx_sched *sched;
	// ...
};
```

每个DSQ内定义了红黑树和任务链表，可以支持调度器实现自己的优先级队列。

```c
struct scx_dispatch_q {
	struct task_struct __rcu *first_task; /* lockless peek at head */
	struct list_head list; /* tasks in dispatch order */
	struct rb_root priq; /* used to order by p->scx.dsq_vtime */
	// ...
};
```

为了保证可编程调度器最大化的自由，每个可编程调度器可以自己定义与管理接近
2^63个DSQ。这些DSQ通过ID来管理，但部分ID是保留的。

```c
/*

 * DSQ (dispatch queue) IDs are 64bit of the format:
 *
 *   Bits: [63] [62 ..  0]
 *         [ B] [   ID   ]
 *
 *    B: 1 for IDs for built-in DSQs, 0 for ops-created user DSQs
 *   ID: 63 bit ID
 *
 * Built-in IDs:
 *
 *   Bits: [63] [62] [61..32] [31 ..  0]
 *         [ 1] [ L] [   R  ] [    V   ]
 *
 *    1: 1 for built-in DSQs.
 *    L: 1 for LOCAL_ON DSQ IDs, 0 for others
 *    V: For LOCAL_ON DSQ IDs, a CPU number. For others, a pre-defined value.
 */
enum scx_dsq_id_flags {
        SCX_DSQ_FLAG_BUILTIN    = 1LLU << 63,
        SCX_DSQ_FLAG_LOCAL_ON   = 1LLU << 62,

        SCX_DSQ_INVALID         = SCX_DSQ_FLAG_BUILTIN | 0,
        SCX_DSQ_GLOBAL          = SCX_DSQ_FLAG_BUILTIN | 1,
        SCX_DSQ_LOCAL           = SCX_DSQ_FLAG_BUILTIN | 2,
        SCX_DSQ_BYPASS          = SCX_DSQ_FLAG_BUILTIN | 3,
        SCX_DSQ_REJECT          = SCX_DSQ_FLAG_BUILTIN | 4,     /* internal - see find_dsq_for_dispatch() */
        SCX_DSQ_RESCUE          = SCX_DSQ_FLAG_BUILTIN | 5,     /* internal - see find_dsq_for_dispatch() */
        SCX_DSQ_LOCAL_ON        = SCX_DSQ_FLAG_BUILTIN | SCX_DSQ_FLAG_LOCAL_ON,
        SCX_DSQ_LOCAL_CPU_MASK  = 0xffffffffLLU,
};
```

保留的DSQ是默认实现的DSQ，每个CPU都有一个自己的local_dsq，保存在runqueue中，
每一种可编程调度器还定义了一个global_dsq。

sched_ext调度类总是会优先从local_dsq中获取第一个任务执行，如果当前CPU的local_dsq
中没有任务，那么会从global_dsq中获取任务执行。

这些DSQ如何使用完全取决于sched_ext调度器，sched_ext调度器也可以使用自己的数据
结构来保存任务，但也需要在回调中把自定义数据结构中的任务添加到
local_dsq/global_dsq中来完成任务的调度。

### sched_ext回调与task的生命周期

sched_ext包含了很多回调，值得注意的主要有以下几个：

```c
s32 (*select_cpu)(struct task_struct *p, s32 prev_cpu, u64 wake_flags);
void (*enqueue)(struct task_struct *p, u64 enq_flags);
void (*dequeue)(struct task_struct *p, u64 deq_flags);
void (*dispatch)(s32 cpu, struct task_struct *prev);
void (*tick)(struct task_struct *p);
void (*runnable)(struct task_struct *p, u64 enq_flags);
void (*running)(struct task_struct *p);
void (*stop)(struct task_struct *p, bool runnable);
void (*quiescent)(struct task_struct *p, u64 deq_flags);
void (*yield)(struct task_struct *from, struct task_struct *to);
void (*core_sched_before)(struct task_struct *a, struct task_struct *b);
void (*set_weight)(struct task_struct *p, u32 weight);
void (*set_cpumask)(struct task_struct *p, const struct cpumask *cpumask);
void (*update_idle)(s32 cpu, bool idle);
void (*exit_task)(struct task_struct *p, struct scx_exit_task_args *args);

void (*enable)(struct task_struct *p);
void (*disable)(struct task_struct *p);

s32 (*init)(void);
void (*exit)(struct scx_exit_info *info);
```

下面是task的生命周期转换的伪代码，包含各个重要回调的调用时机。

```c
ops.init_task();            /* A new task is created */
ops.enable();               /* Enable BPF scheduling for the task */

while (task in SCHED_EXT) {
    if (task can migrate)
        ops.select_cpu();   /* Called on wakeup (optimization) */

    ops.runnable();         /* Task becomes ready to run */

    while (task_is_runnable(task)) {
        if (task is not in a DSQ || task->scx.slice == 0) {
            ops.enqueue();  /* Task can be added to a DSQ */

            /* Task property change (i.e., affinity, nice, etc.)? */
            if (sched_change(task)) {
                ops.dequeue(); /* Exiting BPF scheduler custody */
                ops.quiescent();

                /* Property change callback, e.g. ops.set_weight() */

                ops.runnable();
                continue;
            }

            /* Any usable CPU becomes available */

            ops.dispatch();     /* Task is moved to a local DSQ */
            ops.dequeue();      /* Exiting BPF scheduler custody */
        }

        ops.running();      /* Task starts running on its assigned CPU */

        while (task_is_runnable(task) && task->scx.slice > 0) {
            ops.tick();     /* Called every 1/HZ seconds */

            if (task->scx.slice == 0)
                ops.dispatch(); /* task->scx.slice can be refilled */
        }

        ops.stopping();     /* Task stops running (time slice expires or wait) */
    }

    ops.quiescent();        /* Task releases its assigned CPU (wait) */
}

ops.disable();              /* Disable BPF scheduling for the task */
ops.exit_task();            /* Task is destroyed */
```

注意，sched_ext调度器有一个BPF custody概念，也就是任务受到BPF程序管理。
任务enqueue时，如果task被迁移到调度器自己的队列中管理，认为任务进入BPF custody，
此时任务保存在BPF自定义的队列中管理。
在任务被dispatch时，认为任务退出BPF custody，所以需要调用dequeue，方便调度器回收
资源。

被dispatch到local/global_dsq的任务不在BPF custody状态，因为local/global_dsq受
可信的sched_ext class中间层管理，而不受不可信的可编程调度器管理。

所以dispatch和dequeue是不同的语义：

enqueue：任务进入可编程调度器的视野，受可编程调度器管控
dispatch：为任务实际分配CPU资源，也就是一个具体的local_dsq/global_dsq
dequeue：任务退出可编程调度器的视野，不再受可编程调度器的管控

### scx_simple

一个实际的sched_ext调度器的例子就是scx_simple，这是Linux主线里的一个简单的实例
调度器。

scx_simple使用了一个全局的dsq（SHARED_DSQ）来维护所有需要执行的任务，
支持两种模式：

- FIFO：按任务进入调度的先后排序
- vtime ordered：在task执行前后统计执行时间，跟踪任务的vtime，选择列表中vtime
  最短的任务。

因此，scx_simple的基本思路为：

FIFO:
1. 任务enqueue时，直接把任务添加到global_dsq中。
2. 不需要实现其他回调，因为CPU默认会fallback到global_dsq中取任务。

vtime：

1. 在任务enqueue时，把任务添加到SHARED_DSQ中，按vtime排序
2. 在任务即将被执行时，记录任务的当前的vtime
3. 在任务即将停止执行时，计算任务占用的vtime，更新任务的vtime

由于global_dsq不支持排序，为了尽量在vtime和fifo模式下复用逻辑，scx_simple还是
使用了自定义的shared_dsq。

需要注意的是，任务在被dispatch到local_dsq/global_dsq执行时，
如果被抢占，那么会停留在local_dsq/global_dsq
如果时间片耗尽，那么会调用enqueue重新入队
如果进入睡眠，那么在wakeup时重新入队

因为dispatch时，任务已经被转移到local_dsq/global_dsq，而下次重新进入scx_imple时
会重新enqueue，所以不需要实现dequeue函数回收资源。

### sched_ext中的cgroup

sched_ext不会强制调度器感知cgroup，但提供了回调来通知可编程调度器感知内核cgroup
配置的变化，以此来支持调度器自定义的对cgroup的优化。

主要回调如下：

```c
s32 (*cgroup_init)(struct cgroup *cgrp, struct scx_cgroup_init_args *args);
void (*cgroup_exit)(struct cgroup *cgrp);

s32 (*cgroup_prep_move)(struct task_struct *p,
                       struct cgroup *from, struct cgroup *to);
void (*cgroup_move)(struct task_struct *p,
                   struct cgroup *from, struct cgroup *to);
void (*cgroup_cancel_move)(struct task_struct *p,
                          struct cgroup *from, struct cgroup *to);

void (*cgroup_set_weight)(struct cgroup *cgrp, u32 weight);
void (*cgroup_set_bandwidth)(struct cgroup *cgrp,
                            u64 period_us, u64 quota_us, u64 burst_us);
void (*cgroup_set_idle)(struct cgroup *cgrp, bool idle);
```

### ext_sub_sched

sub-scheduler允许在一个cgroup子树上挂载另一个BPF调度器实例，形成父子调度器层级。
父调度器决定是否接纳子调度器、授予哪些CPU上的哪些能力；子调度器在这个范围内
管理任务，并实现自己的调度策略。它与“一个调度器内部按cgroup分组调度”不同，
父子实例各自拥有自己的回调和状态。

这一节以本地checkout（`d48723711bae`）的CONFIG_EXT_SUB_SCHED实现为准。相关实现
在`kernel/sched/ext/sub.c`，接口定义在`kernel/sched/ext/internal.h`。
主要回调如下：

```c
s32 (*sub_attach)(struct scx_sub_attach_args *args);
void (*sub_detach)(struct scx_sub_detach_args *args);

void (*sub_caps_updated)(const struct scx_cmask *cmask, u64 caps);
void (*sub_ecaps_updated)(s32 cid, u64 before, u64 after);
void (*sub_child_ecaps_updated)(u64 cgroup_id, s32 cid,
                              u64 before, u64 after);

void (*sub_cid_sched_updated)(s32 cid, u64 sched);
```

这里的cid是按拓扑组织的CPU标识，不应直接当成Linux原始CPU编号；cmask表示一组
cid。cid空间按shard分片，使授权与状态通知可以按片处理。当前实现的能力管理
kfunc要求使用cid形式的调度器接口（sched_ext_ops_cid），具体映射见
`kernel/sched/ext/cid.h`。

sub_attach和sub_detach通知父调度器子实例的挂载与退出：

- sub_attach：内核请求父调度器接纳子实例。args包含子调度器的ops及挂载cgroup
  路径；父调度器可以检查这些信息、准备自己的管理状态，并授予初始能力。返回0
  表示接受，负错误码表示拒绝。子实例通过ops.sub_cgroup_id指定挂载目标，大于1
  时表示请求作为sub-scheduler加载。
- sub_detach：通知父调度器子实例退出。调用时子实例已不持有任何能力，不能再影响
  任意cid，父调度器可以清理子实例记录并恢复此前委托的控制状态。不能把它当作
  “现在开始撤回能力”的通知，能力撤回和任务交接发生在此之前。

子调度器的能力通过kfunc授予和撤回，而不是通过直接调用上述回调改变。主要接口是：

- scx_bpf_sub_grant：给直接子调度器授予某些cid上的SCX_CAP_*能力。父调度器必须
  显式持有要转授的能力；授权按cid检查，返回错误时可能已有部分cid授权成功，
  可以通过denied mask查看被拒绝的cid。
- scx_bpf_sub_revoke：撤回直接子调度器及其后代在指定cid上的相应能力。
- scx_bpf_sub_caps：查询自身或直接子调度器的授权状态，cgroup_id为0表示自身。
  查询多个能力位时，返回满足其中任一能力的cid集合；需要区分各项能力时应分别查询。

能力包括local DSQ入队、抢占以及CPU性能控制等不同权限。例如SCX_CAP_ENQ用于
一般任务的local DSQ入队，SCX_CAP_PERF用于CPU性能目标控制。挂载成功不意味着
子调度器自动拥有所有CPU的所有能力；这些能力也不是cpu.weight或cpu.max的数值配额。

能力更新有两个阶段：先修改授权状态，再让变化在相应CPU上生效。三个回调分别用于
观察这两个阶段及父级视角：

- sub_caps_updated：通知子调度器某个shard上的授权状态变化。cmask和caps合并了
  自上次通知以来发生变化的cid及能力位，并不说明哪些位被授予、哪些被撤回，也
  不是当前完整能力集合。应使用scx_bpf_sub_caps查询当前状态。通知是异步的，可以
  用于更新缓存或继续向后代授权，但不能据此认定变化已经在CPU上生效。
- sub_ecaps_updated：通知子调度器某个cid上的有效能力已经变化。before和after
  分别是上次通知与本次通知的有效能力；它在持有rq锁的dispatch上下文运行，可执行
  dispatch允许的操作。正常启用时，任务交接完成后、第一次调度决策前开始收到通知。
- sub_child_ecaps_updated：把直接子调度器的有效能力变化通知父调度器，cgroup_id
  标识该子实例。正常情况下紧接子实例的sub_ecaps_updated调用。父调度器据此知道
  子实例已经失去哪些权限，但仍需确认自己持有相应权限，才能接管CPU操作。

下面的伪代码展示一次正常运行期间的授权与撤回。parent/child.ops表示内核向不同
实例投递回调，不是BPF程序直接调用另一实例的函数；省略了错误处理、锁和分片循环。
授权状态通知与CPU侧生效通知之间不应假定固定的跨CPU执行顺序：

```c
/* Parent policy grants capabilities to a direct child */
scx_bpf_sub_grant(child_id, caps, cmask, denied_mask);

/* Async notification: the recorded grant state changed */
child.ops.sub_caps_updated(changed_cmask, changed_caps);
/* Child queries scx_bpf_sub_caps() to refresh its view */

/* Separately, when the change takes effect on a particular CPU */
child.ops.sub_ecaps_updated(cid, before, after);
parent.ops.sub_child_ecaps_updated(child_id, cid, before, after);

/* Later, parent policy revokes capabilities */
scx_bpf_sub_revoke(child_id, caps, cmask);
/* Corresponding grant-state and effective-state notifications follow */
```

sub_cid_sched_updated通知的不是权限变化，而是“该cid上正在运行哪个调度器的任务”。
参数sched有三种含义：

- SCX_CID_SCHED_NONE：当前没有该调度器子树的任务在此运行，可能是CPU空闲，也可能
  正在运行子树以外的任务。
- SCX_CID_SCHED_SELF：正在运行该调度器自己管理的任务。
- 某个直接子实例的cgroup ID：正在运行该子实例或其后代管理的任务。

这个回调在上下文切换路径上持有rq锁时调用。对于父调度器，只要任务仍属于同一个
直接子实例的子树，内部换任务或换更深层的子调度器都不会产生新的父级通知。因此
它适合跟踪调度器之间的运行归属，不能替代逐任务的running/stopping回调。

实际派发还涉及普通dispatch回调与scx_bpf_sub_dispatch()：当local DSQ为空、CPU
需要任务时，父调度器可以在dispatch中选择一个直接子实例，通过该kfunc请求子实例
派发任务；子实例再从自己的队列中选择任务，或继续请求更深一层的子实例。

```txt
CPU需要任务
    |
    +-- parent.dispatch()
            |
            +-- 选择自己的任务
            |
            +-- scx_bpf_sub_dispatch(child_id)
                    |
                    +-- child.dispatch()
                            |
                            +-- 向当前CPU的local DSQ提供任务
```

卸载时，内核撤回子实例能力并交接任务。正常运行的父调度器会收到子实例的有效能力
丢失通知，然后收到sub_detach；正在禁用的子实例不再收到自己的sub_ecaps_updated，
但父实例仍可收到sub_child_ecaps_updated。如果父实例本身也正在禁用，则不能依赖
它收齐这些通知。

组和任务的交接还会产生cgroup_init/cgroup_exit及init_task/exit_task等回调。因此，
sub_*负责父子关系、资源授权和运行归属，任务与组的具体状态仍通过各自的生命周期
回调管理，不能只实现sub_attach/sub_detach就替代整个调度器的初始化与清理。


## 观察调度行为

观察时可以分成三层：确认调度器是否生效、检查任务如何被调度、比较工作负载的结果。
下面的sysfs路径按本地checkout记录；其他版本的目录布局可能不同。

首先确认当前加载的调度器：

```sh
cat /sys/kernel/sched_ext/state
cat /sys/kernel/sched_ext/root/ops
cat /sys/kernel/sched_ext/enable_seq
cat /sys/kernel/sched_ext/root/events
```

state表示是否启用，root/ops给出根调度器名称，enable_seq是自启动以来的启用计数，
因此非零并不等于当前仍然启用。events记录内核侧sched_ext事件计数。检查一个任务
是否由sched_ext管理，可以读取其调度信息；下面以当前shell为例：

```sh
grep ext.enabled /proc/$$/sched
```

scx_simple用户态程序打印的local/global是累计入队次数，不是队列当前长度，也不是
CPU利用率。比较两个采样点的增量，可以了解直投local与进入共享队列的相对频率，
但不能仅靠这些计数判断延迟或公平性。

观察实际调度时间线，可以在工作负载运行期间使用perf采集调度事件：

```sh
sudo perf sched record -a -- sleep 10
sudo perf sched timehist
sudo perf sched latency
```

record在当前目录生成perf.data；timehist展示任务切换和等待情况，latency汇总任务
可运行后等待CPU的延迟。这些命令需要系统提供perf及相应追踪权限；它们描述内核
调度事件，不直接给出BPF自定义DSQ的完整内容。

进一步分析时，sched_wakeup、sched_switch和sched_migrate_task可以用于关联唤醒、
切换和迁移。需要区分任务睡眠等待外部事件的时间，与任务已经可运行但等待CPU的时间。
若要看到自定义队列长度、vtime分布或某次决策的原因，应由BPF调度器额外导出map、
统计信息或事件，并与调度时间线关联。

内核源码中的scx_show_state.py使用drgn检查sched_ext内部状态，需要相匹配的内核
调试信息和drgn环境。sched_ext发生错误时还会生成调试dump；在SysRq可用时，
SysRq-D请求dump而不终止调度器，SysRq-S则用于中止sched_ext并回退。dump可以通过
sched_ext_dump tracepoint观察，具体方式见
[内核sched_ext文档](https://www.kernel.org/doc/html/latest/scheduler/sched-ext.html)。

比较调度策略时，应固定CPU亲和性、负载规模、运行时间和电源设置，并多次采样。
吞吐量、p95/p99响应延迟、CPU迁移和上下文切换次数需要一起看；交互延迟降低，可能
伴随更多抢占或迁移。不能把某一次测试的改善直接推广到所有工作负载。




## scx社区

[sched-ext/scx社区](https://github.com/sched-ext/scx)探索了不同的调度策略。下面三个
调度器分别侧重延迟关键性、交互任务响应，以及CPU局部性与负载均衡之间的取舍。

### scx_lavd

LAVD（Latency-criticality Aware Virtual Deadline）的核心思想是：不同任务对等待
CPU的敏感程度不同，应根据任务的行为动态判断其延迟关键性，并调整调度顺序。

- 结合任务的等待、唤醒频率及运行时长等信息估计延迟关键性，让关键任务获得更早的
  虚拟deadline，并据此调整时间片等决策，减少交互处理链上的等待。
- 结合共享缓存、核心类型和NUMA拓扑选择CPU，在响应速度和数据局部性之间取舍。

其目标是在游戏等交互负载中减少卡顿和尾延迟，同时保持吞吐量。核心是让更需要及时
响应的任务更早运行，而不是所有任务都使用同样短的时间片。参考
[项目介绍](https://github.com/sched-ext/scx/blob/main/scheds/rust/scx_lavd/README.md)和
[延迟关键性计算](https://github.com/sched-ext/scx/blob/main/scheds/rust/scx_lavd/src/bpf/lat_cri.bpf.c)。

### scx_rustland

scx_rustland的策略侧重让交互任务在CPU密集型后台负载下仍能及时响应。按照作者在
FOSDEM 2025介绍的设计，它结合虚拟运行时间与任务行为计算deadline，优先调度
较早到期的任务。

- 用vruntime反映已经获得的CPU服务，并结合主动上下文切换频率判断交互性，调整
  deadline，使经常短暂运行后等待事件的任务更容易及时获得CPU。
- 根据等待调度的任务数量动态调整时间片：竞争者多时缩短时间片，减少轮转等待；
  竞争者少时允许更长的连续执行。

这种策略适合关注游戏、音视频等交互任务与后台计算并存时的响应，优化目标并非单纯
提高后台任务吞吐量。参考作者的
[FOSDEM 2025演讲](https://archive.fosdem.org/2025/events/attachments/fosdem-2025-4620-rust-ifying-the-linux-kernel-scheduler-in-user-space-/slides/238238/Rust-ifyi_PRcGR8u.pdf)。

### scx_cosmos

scx_cosmos的核心思想是根据负载调整局部性与任务流动性的优先级：负载轻时尽量让
任务留在原CPU，负载饱和时允许更多迁移，让等待中的任务更快获得执行机会。

- 未饱和时保持任务与CPU的亲和性，减少缓存失效和跨CPU协调开销。
- 饱和时采用基于deadline的调度策略，在CPU之间分散任务，改善交互任务相对于
  持续计算任务的响应；同时考虑NUMA局部性。
- 合并CPU唤醒以摊薄调度开销，使较短时间片的使用更可行。

它面向通用桌面和服务器负载，重点是在低负载的局部性收益与高负载的响应需求之间
自动调整。参考
[scx_cosmos项目介绍](https://github.com/sched-ext/scx/blob/main/scheds/rust/scx_cosmos/README.md)。


## Appendix

```c
s32 (*select_cpu)(struct task_struct *p, s32 prev_cpu, u64 wake_flags);
void (*enqueue)(struct task_struct *p, u64 enq_flags);
void (*dequeue)(struct task_struct *p, u64 deq_flags);
void (*dispatch)(s32 cpu, struct task_struct *prev);
void (*tick)(struct task_struct *p);
void (*runnable)(struct task_struct *p, u64 enq_flags);
void (*running)(struct task_struct *p);
void (*stop)(struct task_struct *p, bool runnable);
void (*quiescent)(struct task_struct *p, u64 deq_flags);
void (*yield)(struct task_struct *from, struct task_struct *to);
void (*core_sched_before)(struct task_struct *a, struct task_struct *b);
void (*set_weight)(struct task_struct *p, u32 weight);
void (*set_cpumask)(struct task_struct *p, const struct cpumask *cpumask);
void (*update_idle)(s32 cpu, bool idle);
void (*exit_task)(struct task_struct *p, struct scx_exit_task_args *args);


void (*enable)(struct task_struct *p);
void (*disable)(struct task_struct *p);


void (*dump)(struct scx_dump_ctx *ctx);
void (*dump_cpu)(struct scx_dump_ctx *ctx, s32 cpu, bool idle);
void (*dump_task)(struct scx_dump_ctx *ctx, struct task_struct *p);


void (*cgroup_init)(struct cgroup *cgrp, struct scx_cgroup_init_args *args);
void (*cgroup_exit)(struct cgroup *cgrp);
void (*cgroup_prep_move)(struct task_struct *p,
						 struct cgroup *from, struct cgroup *to);
void (*cgroup_move)(struct task_struct *p,
					struct cgroup *from, struct cgroup *to);
void (*cgroup_cancel_move)(struct task_struct *p,
						   struct cgroup *from, struct cgroup *to);
void (*cgroup_set_weight)(struct cgroup *cgrp, u32 weight);
void (*cgroup_set_bandwidth)(struct cgroup *cgrp,
							 u64 period_us, u64 quota_us, u64 burst_us);
void (*cgroup_set_idle)(struct cgroup *cgrp, bool idle);


void (*sub_detach)(struct scx_sub_detach_args *args);
void (*sub_caps_updated)(const struct scx_cmask *cmask, u64 caps);
void (*sub_ecaps_updated)(s32 cid, u64 before, u64 after);
void (*sub_cid_sched_updated)(s32 cid, u64 sched);
void (*sub_child_ecaps_updated)(u64 cgroup_id, s32 cid, u64 before, u64 after);


void (*cpu_online)(s32 cpu);
void (*cpu_offline)(s32 cpu);
s32 (*init_cids)(void);
s32 (*init)(void);
void (*exit)(struct scx_exit_info *info);
```
