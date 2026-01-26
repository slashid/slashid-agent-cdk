import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Set up VPC peering if the target VPC is different from the source VPC.
 * Creates peering connection and adds routes from source VPC to target VPC.
 * @param scope The CDK construct scope
 * @param sourceVpc The VPC to peer from
 * @param targetVpc The VPC to peer with
 * @param id Unique identifier for the CDK constructs
 * @param peeredVpcIds Set of already-peered VPC IDs (will be mutated)
 */
export function ensureVpcConnectivity(
  scope: Construct,
  sourceVpc: ec2.IVpc,
  targetVpc: ec2.IVpc,
  id: string,
  peeredVpcIds: Set<string>
): void {
  if (targetVpc.vpcId === sourceVpc.vpcId) return;
  if (peeredVpcIds.has(targetVpc.vpcId)) return;

  peeredVpcIds.add(targetVpc.vpcId);

  const peering = new ec2.CfnVPCPeeringConnection(scope, `${id}VpcPeering`, {
    vpcId: sourceVpc.vpcId,
    peerVpcId: targetVpc.vpcId,
  });

  // Collect unique route table IDs (multiple subnets may share the same route table)
  const routeTableIds = new Set<string>();
  [...sourceVpc.publicSubnets, ...sourceVpc.privateSubnets].forEach((subnet: ec2.ISubnet) => {
    routeTableIds.add(subnet.routeTable.routeTableId);
  });

  // Add routes from source VPC to target VPC (one per unique route table)
  let i = 0;
  routeTableIds.forEach((routeTableId) => {
    new ec2.CfnRoute(scope, `${id}Route${i}`, {
      routeTableId,
      destinationCidrBlock: targetVpc.vpcCidrBlock,
      vpcPeeringConnectionId: peering.attrId,
    });
    i++;
  });
}
