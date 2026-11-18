import { CampusProvider } from "@/components/campus-provider";
import { LpuWayfinder } from "@/components/lpu-wayfinder";
import { VisitTracker } from "@/components/visit-tracker";

export default function Page() {
  return (
    <CampusProvider>
      <LpuWayfinder />
      <VisitTracker />
    </CampusProvider>
  );
}
