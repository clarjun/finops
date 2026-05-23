/**
 * Department Allocator
 * Allocates costs to departments/teams based on resource tags
 */

import { DepartmentAllocation, CostAllocationHeatmapData } from './types';
import { getResourceOwnersByService } from '../analysis/aws-tagging-service';

export async function allocateCostsByDepartment(
  provider: 'aws' | 'azure' | 'gcp',
  costData: Array<{ service: string; cost: number }>
): Promise<{
  allocations: DepartmentAllocation[];
  fullServiceData: Array<{ service: string; department: string; cost: number }>;
}> {
  console.log(`[Department Allocator] Allocating costs for ${provider}`);
  
  if (provider !== 'aws') {
    // Placeholder for Azure/GCP
    return { allocations: [], fullServiceData: [] };
  }
  
  try {
    // Get all resources with tags
    const allResources: Array<{
      resourceArn: string;
      resourceType: string;
      owner: string;
      tags: Record<string, string>;
    }> = [];
    
    // Fetch resources for each service (simplified - in production, batch this)
    const services = [...new Set(costData.map(c => c.service))]; // Get all services
    
    for (const service of services) {
      const resources = await getResourceOwnersByService(service);
      allResources.push(...resources);
    }
    
    // Extract department from tags (look for Department, Team, or CostCenter tags)
    const departmentCosts: Record<string, {
      cost: number;
      resourceCount: number;
      services: Record<string, number>;
    }> = {};
    
    const totalResources = allResources.length;
    const totalCost = costData.reduce((sum, c) => sum + c.cost, 0);
    
    if (totalResources === 0) {
      // Fallback: create a single "Unallocated" department
      const allocations = [{
        department: 'Unallocated',
        cost: totalCost,
        percentage: 100,
        resourceCount: 0,
        topServices: costData.slice(0, 3).map(c => ({
          service: c.service,
          cost: c.cost,
        })),
      }];
      
      const fullServiceData = costData.map(c => ({
        service: c.service,
        department: 'Unallocated',
        cost: c.cost,
      }));
      
      return { allocations, fullServiceData };
    }
    
    // Count resources per department
    for (const resource of allResources) {
      const department = 
        resource.tags['Department'] || 
        resource.tags['Team'] || 
        resource.tags['CostCenter'] || 
        resource.owner || 
        'Unallocated';
      
      if (!departmentCosts[department]) {
        departmentCosts[department] = {
          cost: 0,
          resourceCount: 0,
          services: {},
        };
      }
      
      departmentCosts[department].resourceCount++;
    }
    
    // Distribute costs proportionally based on resource count
    for (const [department, data] of Object.entries(departmentCosts)) {
      const proportion = data.resourceCount / totalResources;
      data.cost = totalCost * proportion;
      
      // Distribute service costs proportionally
      for (const serviceData of costData) {
        if (!data.services[serviceData.service]) {
          data.services[serviceData.service] = 0;
        }
        data.services[serviceData.service] += serviceData.cost * proportion;
      }
    }
    
    // Convert to array format
    const allocations: DepartmentAllocation[] = Object.entries(departmentCosts)
      .map(([department, data]) => ({
        department,
        cost: data.cost,
        percentage: totalCost > 0 ? (data.cost / totalCost) * 100 : 0,
        resourceCount: data.resourceCount,
        topServices: Object.entries(data.services)
          .map(([service, cost]) => ({ service, cost }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 3),
      }))
      .sort((a, b) => b.cost - a.cost);
    
    // Build full service data for heatmap (all services, not just top 3)
    const fullServiceData: Array<{ service: string; department: string; cost: number }> = [];
    for (const [department, data] of Object.entries(departmentCosts)) {
      for (const [service, cost] of Object.entries(data.services)) {
        if (cost > 0) {
          fullServiceData.push({ service, department, cost });
        }
      }
    }
    
    console.log(`[Department Allocator] ✓ Allocated to ${allocations.length} departments`);
    console.log(`[Department Allocator] ✓ Generated ${fullServiceData.length} service-department mappings for heatmap`);
    return { allocations, fullServiceData };
    
  } catch (error: any) {
    console.error('[Department Allocator] Error:', error.message);
    
    // Fallback
    const totalCost = costData.reduce((sum, c) => sum + c.cost, 0);
    const allocations = [{
      department: 'Unallocated',
      cost: totalCost,
      percentage: 100,
      resourceCount: 0,
      topServices: costData.slice(0, 3).map(c => ({
        service: c.service,
        cost: c.cost,
      })),
    }];
    
    const fullServiceData = costData.map(c => ({
      service: c.service,
      department: 'Unallocated',
      cost: c.cost,
    }));
    
    return { allocations, fullServiceData };
  }
}

export function generateHeatmapData(
  costData: Array<{ service: string; department: string; cost: number }>
): CostAllocationHeatmapData {
  console.log('[Heatmap Generator] Generating cost allocation heatmap');
  
  // Filter out entries with zero cost
  const nonZeroCostData = costData.filter(c => c.cost > 0);
  
  // Get unique services and departments (all with cost > 0, no limit)
  const services = [...new Set(nonZeroCostData.map(c => c.service))];
  const departments = [...new Set(nonZeroCostData.map(c => c.department))];
  
  console.log(`[Heatmap Generator] Found ${services.length} services and ${departments.length} departments with costs > 0`);
  
  // Create 2D array: [service][department] = cost
  const data: number[][] = [];
  
  for (let i = 0; i < services.length; i++) {
    data[i] = [];
    for (let j = 0; j < departments.length; j++) {
      const cost = nonZeroCostData.find(
        c => c.service === services[i] && c.department === departments[j]
      )?.cost || 0;
      data[i][j] = cost;
    }
  }
  
  console.log(`[Heatmap Generator] ✓ Generated ${services.length}x${departments.length} heatmap (all services with cost > 0)`);
  
  return {
    services,
    departments,
    data,
  };
}
