// design/web-mvp/mockData.js - 独立原型模拟数据契约集 (符合 A1 返修 R1—R6 规范)
window.MOCK_DATA = {
  // 1. 正常场景抓取结果 (Happy Path 模拟文章解析)
  happyArticle: {
    title: "多模态智能体演进：从单向理解走向跨模态深层协同",
    source: "微信公众号 · 极客观察",
    url: "https://mp.weixin.qq.com/s/sample-multimodal-agent",
    wordCount: 3840,
    estimatedDuration: "00:48",
    duration: "00:48",
    durationSeconds: 48,
    summary: "本文深度剖析了多模态智能体从单向文本对话走向全双工实时交互的技术演进路径，重点探讨了视觉-语音对齐、低延迟情绪表达及端侧与云端混合计算的工程取舍。",
    dialogues: [
      { id: "line-1", speaker: "阿泽", role: "host", tone: "好奇开场", text: "哈喽大家好，欢迎收听本期播客！小晓，最近关于端到端智能体的讨论特别火，大家都在说全双工交互，到底是在卷什么呢？", start: 0.0, end: 7.2 },
      { id: "line-2", speaker: "小晓", role: "guest", tone: "敏锐切入", text: "阿泽好！简单说就是机器终于不再像对讲机那样“你说一句我答一句”，而是学会了听你说话时的叹息、犹豫，甚至能随时插话打断。", start: 7.4, end: 15.5 },
      { id: "line-3", speaker: "阿泽", role: "host", tone: "设问求索", text: "听起来很爽，但文章里提到一个非常核心的瓶颈——端侧算力与发热的妥协。在手机上跑这么重的大模型，电池扛得住吗？", start: 15.8, end: 23.0 },
      { id: "line-4", speaker: "小晓", role: "guest", tone: "深度剖析", text: "没错，这就是为什么现在的旗舰手机都在做混合架构：轻量感知留在本地保证0延迟，复杂的深度规划和知识检索依然交给云端。", start: 23.3, end: 32.0 },
      { id: "line-5", speaker: "阿泽", role: "host", tone: "总结金句", text: "有意思！所以就像OPPO的AI妙听一样，把用户从枯燥长文解脱出来的本质，就是把机器逻辑重构成人与人之间自然的对话听感。", start: 32.4, end: 40.2 },
      { id: "line-6", speaker: "小晓", role: "guest", tone: "展望呼应", text: "对，听觉是最高效的并行吸收通道。未来所有的长文档，可能都会变成你耳边这样一场轻松的下午茶对谈。", start: 40.5, end: 48.0 }
    ]
  },

  // 2. 模拟微信反爬错误场景 (Failure Path: 严守事实边界，不冒充原文)
  antiSpiderError: {
    code: "ERR_FETCH_ANTISPIDER",
    stage: "extracting",
    title: "该链接触发目标平台防爬验证",
    message: "检测到目标页面被微信安全拦截（包含反爬验证码重定向或签名校验失败）。系统无法直接读取原文正文。",
    canRetry: true,
    // 仅供演示辅助按钮使用，不可自动冒充
    sampleFallbackText: "2026年，端侧AI推理技术取得了重大突破。业内最新测试显示，基于4-bit量化的混合架构模型已能在消费级终端流畅运转。随着高通与联发科新一代NPU的普及，设备端本地语音特征提取延迟降低至30毫秒以内。这使得实时全双工对话体验在手机和智能耳机上真正具备了可用性，不再完全依赖云端高延迟回传。"
  },

  // 3. 模拟 TTS 超时中断场景 (Recovery Path: 区分限流与超时，统一定义 0-based failedIndex)
  ttsStallScenario: {
    failedIndex: 3, // 0-based 索引 3，即第 4 句（小晓）
    totalLines: 6,
    code: "ERR_TTS_TIMEOUT", // 连接挂起重试超时
    stage: "synthesizing",
    speaker: "小晓",
    role: "guest",
    retryCount: 3,
    maxRetries: 3,
    message: "合成第 4 句（小晓：深度剖析）时 TTS 服务响应超时，连续重试 3 次均未返回音频。"
  },

  // 4. 独立、完整的最近任务历史列表（每个条目具备完整独立的对白与时长）
  recentTasks: [
    {
      id: "task-001",
      title: "多模态智能体演进：从单向理解走向跨模态深层协同",
      time: "10分钟前",
      duration: "00:48",
      durationSeconds: 48,
      source: "微信公众号 · 极客观察",
      status: "completed",
      isCorrupted: false,
      dialogues: [
        { id: "line-1", speaker: "阿泽", role: "host", tone: "好奇开场", text: "哈喽大家好，欢迎收听本期播客！小晓，最近关于端到端智能体的讨论特别火，大家都在说全双工交互，到底是在卷什么呢？", start: 0.0, end: 7.2 },
        { id: "line-2", speaker: "小晓", role: "guest", tone: "敏锐切入", text: "阿泽好！简单说就是机器终于不再像对讲机那样“你说一句我答一句”，而是学会了听你说话时的叹息、犹豫，甚至能随时插话打断。", start: 7.4, end: 15.5 },
        { id: "line-3", speaker: "阿泽", role: "host", tone: "设问求索", text: "听起来很爽，但文章里提到一个非常核心的瓶颈——端侧算力与发热的妥协。在手机上跑这么重的大模型，电池扛得住吗？", start: 15.8, end: 23.0 },
        { id: "line-4", speaker: "小晓", role: "guest", tone: "深度剖析", text: "没错，这就是为什么现在的旗舰手机都在做混合架构：轻量感知留在本地保证0延迟，复杂的深度规划和知识检索依然交给云端。", start: 23.3, end: 32.0 },
        { id: "line-5", speaker: "阿泽", role: "host", tone: "总结金句", text: "有意思！所以就像OPPO的AI妙听一样，把用户从枯燥长文解脱出来的本质，就是把机器逻辑重构成人与人之间自然的对话听感。", start: 32.4, end: 40.2 },
        { id: "line-6", speaker: "小晓", role: "guest", tone: "展望呼应", text: "对，听觉是最高效的并行吸收通道。未来所有的长文档，可能都会变成你耳边这样一场轻松的下午茶对谈。", start: 40.5, end: 48.0 }
      ]
    },
    {
      id: "task-002",
      title: "深度拆解：OPPO AI妙听背后的音频流式处理架构",
      time: "昨天 18:20",
      duration: "01:15",
      durationSeconds: 75,
      source: "专栏 · 移动声学前沿",
      status: "completed",
      isCorrupted: false,
      dialogues: [
        { id: "t2-1", speaker: "阿泽", role: "host", tone: "热烈引入", text: "听友们好，今天我们要聊一个特别硬核的话题：为什么有的手机AI朗读像机器人念经，而OPPO的AI妙听却能听出真人的停顿感？", start: 0.0, end: 9.5 },
        { id: "t2-2", speaker: "小晓", role: "guest", tone: "技术拆解", text: "阿泽问到了点子上！传统TTS是整段文字扔进去硬算，妙听的核心突破在于分句流式预判，把长文打散成富有对话呼吸感的短语单元。", start: 9.8, end: 22.0 },
        { id: "t2-3", speaker: "阿泽", role: "host", tone: "追问细节", text: "也就是说，它不是简单地给文章断句，而是在重构剧本时就给男女主播分配了互相补充的论点？", start: 22.4, end: 32.8 },
        { id: "t2-4", speaker: "小晓", role: "guest", tone: "生动举例", text: "对！主持人负责抛出痛点和常识疑问，嘉宾负责提供专业数据与行业视角的解释，双方的语气还会根据话题反转。", start: 33.2, end: 46.5 },
        { id: "t2-5", speaker: "阿泽", role: "host", tone: "工程考量", text: "音频拼接也非常关键。如果两个气口之间没有精准对齐或者静音补偿，听起来就会有非常别扭的卡顿或者抢话。", start: 47.0, end: 59.0 },
        { id: "t2-6", speaker: "小晓", role: "guest", tone: "收尾定调", text: "没错，通过毫秒级帧长计算与平滑拼接，最终呈现出几乎无法察觉拼接痕迹的连贯音频流。", start: 59.5, end: 75.0 }
      ]
    },
    {
      id: "task-003",
      title: "数字游民新工作范式与AI协作工具链",
      time: "9月20日",
      duration: "00:54",
      durationSeconds: 54,
      source: "个人随笔 · 少数派",
      status: "completed",
      isCorrupted: false,
      dialogues: [
        { id: "t3-1", speaker: "阿泽", role: "host", tone: "轻快开场", text: "欢迎收听！小晓，这几年越来越多人选择带上一台笔记本环游世界，边旅居边工作，他们日常靠什么工具维持高产出呢？", start: 0.0, end: 10.2 },
        { id: "t3-2", speaker: "小晓", role: "guest", tone: "经历分享", text: "其实真正的数字游民早已告别了繁重的手动整理，大家核心依靠的是异步沟通机制，加上自动化信息过滤智能体。", start: 10.6, end: 23.4 },
        { id: "t3-3", speaker: "阿泽", role: "host", tone: "现实反思", text: "但时差和不同时区的会议依然很折磨人吧？尤其是需要阅读海量项目文档和会议纪要的时候。", start: 23.8, end: 34.0 },
        { id: "t3-4", speaker: "小晓", role: "guest", tone: "经验总结", text: "所以现在最流行的做法就是把长篇更新转成音频，在晨跑或通勤路上听完，把最清醒的整块时间留给核心创作。", start: 34.5, end: 54.0 }
      ]
    },
    {
      id: "task-004-corrupted",
      title: "【异常用例】已失效历史音频：Web3与去中心化存储探析",
      time: "9月18日",
      duration: "01:20",
      durationSeconds: 80,
      source: "博客归档",
      status: "completed",
      isCorrupted: true, // 模拟本地缓存音频文件丢失或解码失败
      dialogues: []
    }
  ]
};
