import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitions, queryDefinitionRevision } from '../../packages/observability-query/index.mjs';

const outcomeMappings = [
  {
    type: 'value',
    options: {
      started: { text: '已启动 (started)', color: 'blue' },
      progress: { text: '进行中 (progress)', color: 'purple' },
      ok: { text: '成功 (ok)', color: 'green' },
      failed: { text: '失败 (failed)', color: 'red' },
      timeout: { text: '超时 (timeout)', color: 'orange' },
      aborted: { text: '已中止 (aborted)', color: 'dark-red' },
      unfinished: { text: '未完成 (unfinished)', color: 'yellow' },
      unknown: { text: '未知 (unknown)', color: 'text' }
    }
  }
];

const operationMappings = [
  {
    type: 'value',
    options: {
      navigation: { text: '页面导航 (navigation)' },
      thread_open: { text: '打开会话 (thread_open)' },
      catalog_first: { text: '模型首选 (catalog_first)' },
      catalog_complete: { text: '完整目录加载 (catalog_complete)' },
      configuration_confirmed: { text: '配置确认 (configuration_confirmed)' },
      submit_ready: { text: '输入就绪 (submit_ready)' },
      preference_save: { text: '偏好保存 (preference_save)' },
      recovery: { text: '状态恢复 (recovery)' },
      other: { text: '其他操作 (other)' }
    }
  }
];

const componentMappings = [
  {
    type: 'value',
    options: {
      web: { text: 'Web 前台 (web)' },
      gateway: { text: '网关守护 (gateway)' },
      core: { text: '核心内核 (core)' },
      codex: { text: 'Codex 引擎 (codex)' },
      dsh: { text: 'DSH 引擎 (dsh)' },
      pi: { text: 'Pi 引擎 (pi)' },
      observe: { text: '可观测服务 (observe)' },
      collector: { text: '指标采集器 (collector)' },
      prometheus: { text: 'Prometheus 时序库 (prometheus)' },
      loki: { text: 'Loki 日志库 (loki)' },
      grafana: { text: 'Grafana 看板 (grafana)' }
    }
  }
];

export async function generate(directory = dirname(fileURLToPath(import.meta.url))) {
  const root = resolve(directory, 'provisioning');
  for (const sub of ['datasources', 'dashboards']) await mkdir(resolve(root, sub), { recursive: true });
  await writeFile(resolve(root, 'datasources/default.yaml'), `apiVersion: 1\ndatasources:\n  - name: OpenCraft metrics\n    uid: opencraft-prometheus\n    type: prometheus\n    access: proxy\n    url: http://127.0.0.1:23302\n    isDefault: true\n    editable: false\n    jsonData:\n      httpMethod: POST\n      timeInterval: 15s\n  - name: OpenCraft diagnostics\n    uid: opencraft-loki\n    type: loki\n    access: proxy\n    url: http://127.0.0.1:23303\n    editable: false\n    jsonData:\n      maxLines: 500\n`);
  await writeFile(resolve(root, 'dashboards/default.yaml'), `apiVersion: 1\nproviders:\n  - name: OpenCraft\n    orgId: 1\n    folder: OpenCraft\n    type: file\n    disableDeletion: true\n    allowUiUpdates: false\n    options:\n      path: /etc/grafana/provisioning/dashboards\n`);

  const sections = [
    {
      title: '用户交互与耗时体验',
      panels: [
        {
          key: 'operations.latency',
          legendFormat: '{{operation}} [{{cache}}] ({{engine}})',
          mappings: operationMappings,
          description: 'operations.latency; histogram_approximation; ' + queryDefinitionRevision + '。前台关键交互操作（如打开会话、页面导航等）端到端 P95 耗时估算值。无样本不代表服务健康；直方图分位数由 5 分钟滑动窗口桶估算。'
        },
        {
          key: 'operations.outcomes',
          legendFormat: '{{operation}} - {{outcome}} ({{origin}})',
          mappings: outcomeMappings,
          description: 'operations.outcomes; histogram_approximation; ' + queryDefinitionRevision + '。前台交互操作的成功/失败/超时状态统计（按交互来源 origin 划分）。无样本不代表服务健康；增量由 5 分钟滑动窗口估算。'
        },
        {
          key: 'usage.activity24h',
          legendFormat: '24小时活跃真人 ({{actor}})',
          description: 'usage.activity24h; exact_domain_aggregation; ' + queryDefinitionRevision + '。过去 24 小时内经过认证并产生交互行为的真人独立用户数。领域精确指标，按评估时间点实时去重。'
        },
        {
          key: 'usage.activity',
          legendFormat: '7天活跃真人 ({{actor}})',
          description: 'usage.activity; exact_domain_aggregation; ' + queryDefinitionRevision + '。过去 7 天内经过认证并产生交互行为的真人独立用户数。领域精确指标，按评估时间点实时去重。'
        }
      ]
    },
    {
      title: 'RPC 依赖与网关通信',
      panels: [
        {
          key: 'dependencies.summary',
          legendFormat: '{{method}} [{{outcome}}]',
          mappings: outcomeMappings,
          description: 'dependencies.summary; histogram_approximation; ' + queryDefinitionRevision + '。Web 前端与网关、网关与后端各 RPC 方法的调用频次与执行结果。覆盖 thread/*, turn/*, tasks/*, fs/* 等完整方法名分类。'
        },
        {
          key: 'recovery.episodes',
          legendFormat: '恢复周期数',
          description: 'recovery.episodes; exact_domain_aggregation; ' + queryDefinitionRevision + '。连接断开后执行状态恢复与重连协调的完整恢复周期次数。领域精确指标。'
        }
      ]
    },
    {
      title: 'Agent 引擎执行与排队状态',
      panels: [
        {
          key: 'execution.progress',
          legendFormat: '执行状态: {{outcome}}',
          mappings: outcomeMappings,
          description: 'execution.progress; exact_domain_aggregation; ' + queryDefinitionRevision + '。Agent 任务执行轮次在 started/progress/ok/failed/aborted 等生命周期状态上的精确分布。非终态保持 started，无偏差低报。'
        },
        {
          key: 'execution.stages',
          legendFormat: '{{engine}} 引擎 - {{stage}} 阶段',
          description: 'execution.stages; exact_domain_aggregation; ' + queryDefinitionRevision + '。当前正在运行中的 Agent 任务所处的执行阶段（model思考/tool工具执行/human人机交互/queued排队等），自动过滤超过 30 分钟停滞的僵尸挂起。'
        },
        {
          key: 'execution.last_progress',
          legendFormat: '{{engine}} 停滞时长 (秒)',
          description: 'execution.last_progress; resource_sample; ' + queryDefinitionRevision + '。当前活跃任务中最早一次进度更新距离当前时间的秒数，用以监控挂起或卡死风险。'
        },
        {
          key: 'queues.summary',
          legendFormat: '{{engine}} 队列排队数',
          description: 'queues.summary; resource_sample; ' + queryDefinitionRevision + '。在执行队列中等待调度的提交项数，反映当前引擎负载排队压力。'
        }
      ]
    },
    {
      title: '系统资源占用与进程监控',
      panels: [
        {
          key: 'resources.summary',
          legendFormat: '{{component}} 常驻内存',
          mappings: componentMappings,
          description: 'resources.summary; resource_sample; ' + queryDefinitionRevision + '。各核心服务与引擎进程实际占用的物理常驻内存大小。pi 引擎与 gateway 进程独立标识上报，无混淆复计。'
        },
        {
          custom: {
            id: 90,
            type: 'timeseries',
            title: '进程 CPU 占用核数（采样估算）',
            description: 'process_cpu; resource_sample; ' + queryDefinitionRevision + '。各服务进程在采样周期内消耗的 CPU 核数速率估算。',
            datasource: { type: 'prometheus', uid: 'opencraft-prometheus' },
            targets: [{ refId: 'A', expr: 'rate(opencraft_process_cpu_seconds_total[5m])', legendFormat: '{{component}} CPU 核数', range: true }],
            fieldConfig: { defaults: { unit: 'none', mappings: componentMappings }, overrides: [] }
          }
        }
      ]
    },
    {
      title: '平台健康度与采集覆盖',
      panels: [
        {
          key: 'platform.status',
          legendFormat: '{{component}} (生产者: {{producerId}})',
          mappings: componentMappings,
          description: 'platform.status; resource_sample; ' + queryDefinitionRevision + '。各遥测数据生产者的生存心跳与年龄（秒）。生产者长期未心跳可能表明采集管道中断。'
        },
        {
          key: 'components.versions',
          legendFormat: '{{component}} 身份已知: {{known}}',
          mappings: componentMappings,
          description: 'components.versions; resource_sample; ' + queryDefinitionRevision + '。各运行组件的版本与构建身份是否已成功识别和关联。'
        },
        {
          key: 'data.coverage',
          legendFormat: '{{component}} 丢弃数 (原因: {{reason}})',
          mappings: componentMappings,
          description: 'data.coverage; resource_sample; ' + queryDefinitionRevision + '。各组件在客户端队列、传输或服务端由于溢出或反压丢弃的遥测事件计数。'
        }
      ]
    },
    {
      title: '结构化诊断日志',
      panels: [
        {
          custom: {
            id: 100,
            type: 'logs',
            title: '结构化诊断日志（已脱敏元数据）',
            description: 'loki.diagnostics; event_sample; ' + queryDefinitionRevision + '。平台实时收集的结构化诊断事件与错误现场，仅包含受控元数据，不包含任何业务私有负载与秘钥。',
            datasource: { type: 'loki', uid: 'opencraft-loki' },
            targets: [{ refId: 'A', expr: '{service_name="opencraft"}', queryType: 'range', maxLines: 100 }]
          }
        }
      ]
    }
  ];

  let nextId = 1;
  let currentY = 0;
  const panels = [];

  for (const section of sections) {
    const rowId = nextId++;
    panels.push({
      id: rowId,
      type: 'row',
      title: section.title,
      collapsed: false,
      gridPos: { x: 0, y: currentY, w: 24, h: 1 }
    });
    currentY += 1;

    let col = 0;
    let rowH = 8;
    for (let pIdx = 0; pIdx < section.panels.length; pIdx++) {
      const cfg = section.panels[pIdx];
      let p;
      if (cfg.custom) {
        p = cfg.custom;
        if (!p.id) p.id = nextId++;
        const isLog = p.type === 'logs';
        const w = isLog ? 24 : 12;
        const h = isLog ? 10 : 8;
        if (isLog && col !== 0) {
          currentY += rowH;
          col = 0;
        }
        p.gridPos = { x: col, y: currentY, w, h };
        if (isLog) {
          currentY += h;
          col = 0;
        } else {
          col += w;
          if (col >= 24) {
            currentY += h;
            col = 0;
          }
        }
      } else {
        const d = definitions[cfg.key];
        const panelId = nextId++;
        p = {
          id: panelId,
          type: 'timeseries',
          title: d.title,
          description: cfg.description,
          gridPos: { x: col, y: currentY, w: 12, h: 8 },
          datasource: { type: 'prometheus', uid: 'opencraft-prometheus' },
          targets: [{
            refId: 'A',
            expr: d.promql,
            legendFormat: cfg.legendFormat,
            range: true
          }],
          fieldConfig: {
            defaults: {
              unit: d.unit === 'seconds' ? 's' : d.unit === 'bytes' ? 'bytes' : 'short',
              mappings: cfg.mappings ?? []
            },
            overrides: []
          }
        };
        col += 12;
        if (col >= 24) {
          currentY += 8;
          col = 0;
        }
      }
      panels.push(p);
    }
    if (col !== 0) {
      currentY += rowH;
      col = 0;
    }
  }

  await writeFile(
    resolve(root, 'dashboards/overview.json'),
    JSON.stringify(
      {
        uid: 'opencraft-overview',
        title: 'OpenCraft 平台全景可观测性看板',
        schemaVersion: 39,
        version: 1,
        editable: false,
        timezone: 'utc',
        refresh: '30s',
        time: { from: 'now-15m', to: 'now' },
        tags: ['opencraft', queryDefinitionRevision, '可观测性'],
        panels
      },
      null,
      2
    ) + '\n'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generate(process.argv[2]);
