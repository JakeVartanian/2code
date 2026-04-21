/**
 * AuditDashboard — the primary content below the architecture map.
 * Shows audit runs, findings, trends, and profiles.
 */

import { memo } from "react"
import { ShieldCheck, Search, TrendingUp, Settings2 } from "lucide-react"
import { MapSection } from "../map-section"
import { RecentRuns } from "./recent-runs"
import { FindingsBrowser } from "./findings-browser"
import { AuditTrends } from "./audit-trends"
import { AuditProfilesList } from "./audit-profiles"
import { trpc } from "../../../../../lib/trpc"

interface AuditDashboardProps {
  projectId: string | null
  chatId: string
}

export const AuditDashboard = memo(function AuditDashboard({
  projectId,
  chatId,
}: AuditDashboardProps) {
  // Fetch counts for section headers
  const runsQuery = trpc.ambient.listAuditRuns.useQuery(
    { projectId: projectId!, limit: 1 },
    { enabled: !!projectId },
  )
  const findingsQuery = trpc.ambient.listAuditFindings.useQuery(
    { projectId: projectId!, status: "open", limit: 1 },
    { enabled: !!projectId },
  )
  const profilesQuery = trpc.ambient.listAuditProfiles.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId },
  )

  if (!projectId) {
    return (
      <div className="text-center py-12">
        <p className="text-xs text-zinc-600">Select a project to view audits.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <MapSection
        title="Recent Audit Runs"
        icon={<ShieldCheck className="w-4 h-4" />}
        accentColor="cyan"
        defaultOpen
      >
        <RecentRuns projectId={projectId} chatId={chatId} />
      </MapSection>

      <MapSection
        title="Findings"
        icon={<Search className="w-4 h-4" />}
        accentColor="amber"
        defaultOpen
      >
        <FindingsBrowser projectId={projectId} chatId={chatId} />
      </MapSection>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MapSection
          title="Audit Trends"
          icon={<TrendingUp className="w-4 h-4" />}
          accentColor="green"
          defaultOpen
        >
          <AuditTrends projectId={projectId} />
        </MapSection>

        <MapSection
          title="Audit Profiles"
          icon={<Settings2 className="w-4 h-4" />}
          count={profilesQuery.data?.length}
          accentColor="purple"
          defaultOpen={!!profilesQuery.data?.length}
        >
          <AuditProfilesList projectId={projectId} />
        </MapSection>
      </div>
    </div>
  )
})
