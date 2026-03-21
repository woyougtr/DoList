// Cloudflare Worker - 待办提醒定时检查
// 每小时运行一次，检查需要提醒的待办并发送钉钉通知

const SUPABASE_URL = 'https://cbsjlqnfwqtbydubcrpj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNic2pscW5md3F0YnlkdWJjcnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTQ4ODUsImV4cCI6MjA4OTU5MDg4NX0.AZZCotXt-EZP3hl1RoW_PUjWPfcnmdbAvYIxtFN7h2Q';

// 钉钉自定义机器人 Webhook
const DINGTALK_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=ba334208c606c506094aa6bb1c214f8f227cc1b72ccee484e5c5369d40ee96d1';

// 添加 CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Supabase API 调用
async function supabaseQuery(query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    }
  });
  return response.json();
}

// Supabase 更新
async function supabaseUpdate(table, id, data) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return response.ok;
}

// 通过钉钉自定义机器人发送推送
async function sendDingTalkPush(todo) {
  const remindAt = new Date(todo.remind_at);
  
  // 计算剩余时间用于消息
  const now = new Date();
  const diffMs = remindAt.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  let timeStr = '';
  if (diffHours >= 1) timeStr = `${diffHours}小时${diffMins > 0 ? diffMins + '分钟' : ''}`;
  else timeStr = `${diffMins}分钟`;
  
  const categoryName = todo.category === 'work' ? '🏢 工作' : todo.category === 'life' ? '🏠 生活' : '📚 学习';
  const priorityLabel = todo.priority === 'urgent' ? '⚡ 紧急' : '○ 普通';
  
  // 钉钉 Markdown 格式，标题包含关键字 DoList待办提醒
  const title = 'DoList待办提醒';
  const content = `## 📌 「${todo.text}」\n\n---\n\n⏰ **剩余时间**：${timeStr}\n\n📋 **分类**：${categoryName}  \n📌 **优先级**：${priorityLabel}\n\n---\n\n👉 [点击立即处理](https://woyougtr.github.io/DoList/)`;
  
  try {
    const response = await fetch(DINGTALK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: title,
          text: content
        },
        at: {
          isAtAll: true
        }
      })
    });
    
    const result = await response.json();
    if (result.errcode === 0) {
      console.log(`已推送提醒: ${todo.id}`);
      return true;
    } else {
      console.error(`推送失败: ${result.errmsg}`);
      return false;
    }
  } catch (e) {
    console.error(`推送异常: ${e.message}`);
    return false;
  }
}

// 主函数
export default {
  async scheduled(event, env, ctx) {
    console.log('开始检查待办提醒...');
    
    try {
      // 查询需要提醒的待办（提前1小时内到期，已设置提醒且未通知）
      const now = new Date();
      const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      
      const todos = await supabaseQuery(
        `todos?select=*&remind_at=lte.${oneHourLater}&remind_at=gte.${now.toISOString()}&notified=eq.false&completed=eq.false`
      );
      
      if (!todos || todos.length === 0) {
        console.log('没有需要提醒的待办');
        return;
      }
      
      console.log(`找到 ${todos.length} 个待办需要提醒`);
      
      for (const todo of todos) {
        const success = await sendDingTalkPush(todo);
        if (success) {
          // 标记为已通知
          await supabaseUpdate('todos', todo.id, { notified: true });
        }
      }
      
      console.log('提醒检查完成');
    } catch (e) {
      console.error('检查失败:', e.message);
    }
  },
  
  // HTTP 处理（可选，用于手动触发测试）
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // 手动触发检查
    if (request.method === 'POST' && new URL(request.url).pathname === '/check') {
      await this.scheduled(null, env, null);
      return new Response(JSON.stringify({ success: true, message: '检查完成' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
};
