import { ProvisionForm } from "@/components/provision/provision-form";
import { PageHeader } from "@/components/shared/page-header";

export default function ProvisionPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="快速开通"
        description="一键完成用户注册、订阅开通和 API Key 生成。"
      />
      <ProvisionForm />
    </div>
  );
}
