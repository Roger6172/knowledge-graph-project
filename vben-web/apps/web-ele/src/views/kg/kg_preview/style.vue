<script lang="ts">
import SpriteText from 'three-spritetext'

export interface StyledNode {
	id: string
	label: string
	value?: number
	category?: string
}

export interface NodeStyleContext {
	THREE: Record<string, any>
	node: StyledNode
	getCategoryColor: (category: string) => string
	nodeSize: number
	showLabels: boolean
}

export type NodeStyleRenderer = (context: NodeStyleContext) => any

function createLabel(nodeLabel: string, radius: number, categoryColor: string) {
	const label = new SpriteText(nodeLabel)
	label.color = '#f4f8ff'
	label.textHeight = 10
	label.backgroundColor = 'rgba(12, 24, 48, 0.78)'
	label.borderColor = `${categoryColor}CC`
	label.borderWidth = 1.2
	label.padding = [4, 8]
	label.fontWeight = '600'
	const sprite = label as unknown as {
		material?: { depthWrite: boolean }
		position: { set: (x: number, y: number, z: number) => void }
	}
	if (sprite.material) sprite.material.depthWrite = false
	sprite.position.set(0, radius + 18, 0)
	return label
}

function createStyleOne(context: NodeStyleContext) {
	const { THREE, node, getCategoryColor, nodeSize, showLabels } = context
	const group = new THREE.Group()
	const categoryColor = getCategoryColor(node.category ?? '')
	const baseColor = new THREE.Color(categoryColor)
	const radius = Math.max(((node.value ?? 10) * 0.12 + 6) * nodeSize, 8)
	const glowColor = baseColor.clone().lerp(new THREE.Color('#4ecdc4'), 0.25)
	const highlightColor = baseColor.clone().lerp(new THREE.Color('#ffffff'), 0.45)

	const coreGeometry = new THREE.SphereGeometry(radius * 0.6, 40, 32)
	const coreMaterial = new THREE.MeshStandardMaterial({
		color: highlightColor,
		emissive: glowColor,
		emissiveIntensity: 0.7,
		metalness: 0.6,
		roughness: 0.15
	})
	group.add(new THREE.Mesh(coreGeometry, coreMaterial))

	const shellGeometry = new THREE.SphereGeometry(radius, 48, 36)
	const shellMaterial = THREE.MeshPhysicalMaterial
		? new THREE.MeshPhysicalMaterial({
			color: baseColor,
			transparent: true,
			opacity: 0.32,
			transmission: 0.86,
			thickness: Math.max(radius * 0.3, 2),
			roughness: 0.05,
			metalness: 0.35,
			clearcoat: 0.6,
			clearcoatRoughness: 0.12
		})
		: new THREE.MeshStandardMaterial({
			color: baseColor,
			transparent: true,
			opacity: 0.28,
			metalness: 0.35,
			roughness: 0.12
		})
	const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial)
	shellMesh.renderOrder = 1
	group.add(shellMesh)

	const highlightGeometry = new THREE.SphereGeometry(radius * 1.04, 32, 24, 0, Math.PI * 2, 0, Math.PI / 2.4)
	const highlightMaterial = new THREE.MeshBasicMaterial({
		color: '#ffffff',
		transparent: true,
		opacity: 0.18,
		side: THREE.BackSide,
		depthWrite: false
	})
	const highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial)
	highlightMesh.rotation.set(-Math.PI / 7, Math.PI / 6, 0)
	group.add(highlightMesh)

	if (THREE.TorusGeometry) {
		const orbitGeometry = new THREE.TorusGeometry(radius * 1.35, radius * 0.08, 12, 48)
		const orbitMaterial = new THREE.MeshBasicMaterial({
			color: highlightColor,
			transparent: true,
			opacity: 0.38
		})
		const orbitMesh = new THREE.Mesh(orbitGeometry, orbitMaterial)
		orbitMesh.rotation.x = Math.PI / 2.6
		orbitMesh.rotation.z = Math.PI / 4
		group.add(orbitMesh)
	}

	const haloGeometry = new THREE.SphereGeometry(radius * 1.55, 24, 20)
	const haloMaterial = new THREE.MeshBasicMaterial({
		color: glowColor,
		transparent: true,
		opacity: 0.16,
		blending: THREE.AdditiveBlending,
		side: THREE.BackSide,
		depthWrite: false
	})
	group.add(new THREE.Mesh(haloGeometry, haloMaterial))

	if (THREE.PointLight) {
		const accentLight = new THREE.PointLight(glowColor, 1.1, radius * 4)
		group.add(accentLight)
	}

	if (showLabels) {
		group.add(createLabel(node.label, radius, categoryColor))
	}

	return group
}

function createStyleTwo(context: NodeStyleContext) {
	const { THREE, node, getCategoryColor, nodeSize, showLabels } = context
	const group = new THREE.Group()
	const categoryColor = getCategoryColor(node.category ?? '')
	const baseColor = new THREE.Color(categoryColor)
	const radius = Math.max(((node.value ?? 10) * 0.12 + 6) * nodeSize, 8)

	const polyGeometry = new THREE.IcosahedronGeometry(radius * 0.9, 1)
	const polyMaterial = new THREE.MeshStandardMaterial({
		color: baseColor,
		metalness: 0.45,
		roughness: 0.35,
		emissive: baseColor.clone().multiplyScalar(0.2),
		flatShading: true
	})
	const polyMesh = new THREE.Mesh(polyGeometry, polyMaterial)
	group.add(polyMesh)

	if (THREE.EdgesGeometry && THREE.LineBasicMaterial) {
		const edges = new THREE.EdgesGeometry(polyGeometry)
		const edgeMaterial = new THREE.LineBasicMaterial({
			color: baseColor.clone().lerp(new THREE.Color('#ffffff'), 0.3),
			transparent: true,
			opacity: 0.6
		})
		const edgeLines = new THREE.LineSegments(edges, edgeMaterial)
		group.add(edgeLines)
	}

	const ringGeometry = new THREE.RingGeometry(radius * 1.05, radius * 1.2, 48)
	const ringMaterial = new THREE.MeshBasicMaterial({
		color: baseColor.clone().lerp(new THREE.Color('#00f5d4'), 0.4),
		transparent: true,
		opacity: 0.4,
		side: THREE.DoubleSide
	})
	const ringMesh = new THREE.Mesh(ringGeometry, ringMaterial)
	ringMesh.rotation.x = Math.PI / 2
	group.add(ringMesh)

	const pulseGeometry = new THREE.PlaneGeometry(radius * 1.4, radius * 1.4)
	const pulseMaterial = new THREE.MeshBasicMaterial({
		color: baseColor.clone().lerp(new THREE.Color('#1be7ff'), 0.3),
		transparent: true,
		opacity: 0.2,
		depthWrite: false
	})
	const pulsePlane = new THREE.Mesh(pulseGeometry, pulseMaterial)
	pulsePlane.rotation.x = Math.PI / 2
	group.add(pulsePlane)

	if (showLabels) {
		group.add(createLabel(node.label, radius * 0.9, categoryColor))
	}

	return group
}

export const nodeStyleDefinitions: Record<string, NodeStyleRenderer> = {
	style1: createStyleOne,
	style2: createStyleTwo
}

export type NodeStyleKey = keyof typeof nodeStyleDefinitions

export default {}
</script>

<template />
